package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.api.LocationPoint;
import com.example.gather.api.AuditLogModels.AuditChange;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.maps.AmapTransport;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.*;
import com.example.gather.support.OwnedIntegrationFixtures;
import com.example.gather.support.OwnedIntegrationFixtures.FavoriteKey;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.*;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL V15 persistence/transactions; AMap transport is a contract replacement, never a real provider claim. */
@SpringBootTest(properties = {"app.maps.js-key=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "app.maps.js-security-code=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(LocationIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ExtendWith(OutputCaptureExtension.class)
class LocationIntegrationTest {
    static final Instant NOW = Instant.parse("2048-10-01T09:00:00.123456Z");
    static final Instant START = NOW.plusSeconds(3600);
    static final LocationPoint POINT = point("116.3974285", "39.9092345");
    static final LocationPoint OTHER = point("121.4737012", "31.2304167");
    static final String DESCRIPTION = "Owned location fixture";
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary Clock locationClock() { return Clock.fixed(NOW, ZoneOffset.UTC); }
        @Bean LocationQueries locationQueries() { return new LocationQueries(); }
        @Bean @Primary ContractTransport locationTransport() { return new ContractTransport(); }
    }
    static class ContractTransport implements AmapTransport {
        final AtomicReference<URI> last = new AtomicReference<>();
        @Override public Response get(URI uri) {
            last.set(uri); return new Response(200, "application/json", "{\"status\":\"1\",\"tips\":[]}".getBytes(StandardCharsets.UTF_8));
        }
    }
    record Query(String id, String sql, boolean readOnly, Integer isolation) {}
    @Intercepts({@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})})
    static class LocationQueries implements Interceptor {
        final AtomicBoolean failAudit = new AtomicBoolean();
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (statement.getId().endsWith("AuditLogMapper.insert") && failAudit.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected location audit failure");
            if (captured.get() != null) captured.get().add(new Query(statement.getId(), statement.getBoundSql(invocation.getArgs()[1]).getSql(),
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(), TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            return invocation.proceed();
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Location tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"), "activity"));
        properties.add("spring.datasource.password", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"), "activity_dev_password"));
        properties.add("app.demo-seed-enabled", () -> "true");
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired UserMapper users;
    @Autowired ActivityMapper mapper;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired FavoriteService favorites;
    @Autowired AuditLogService audit;
    @Autowired AdminService admin;
    @Autowired LocationQueries queries;
    @Autowired ContractTransport transport;
    final String prefix = "location_" + UUID.randomUUID();
    final Map<Long, String> fixtureActivities = new LinkedHashMap<>();
    final Map<Long, String> fixtureUsers = new LinkedHashMap<>();
    final List<FavoriteKey> favoriteKeys = new ArrayList<>();

    @BeforeEach void verifyDedicatedV15BeforeWritingFixtures() {
        com.example.gather.support.OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(15);
        OwnedIntegrationFixtures.verifyLocationPointSchema(jdbc);
    }
    @AfterEach void cleanup() {
        queries.failAudit.set(false); queries.captured.remove();
        fixtureActivities.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        fixtureUsers.forEach((id, username) -> assertThat(users.findById(id).username()).isEqualTo(username));
        OwnedIntegrationFixtures.remove(jdbc, fixtureActivities.keySet(), fixtureUsers.keySet(), favoriteKeys);
    }

    @Test void databaseRejectsPartialAndOutOfRangePairsAndLegacyInsertKeepsNullWithoutBackfill() {
        var legacy = new NewActivity(prefix, DESCRIPTION, "会场", LocalDateTime.ofInstant(START, ZoneOffset.UTC), 2, adminId());
        mapper.insert(legacy); fixtureActivities.put(legacy.id, legacy.title);
        assertThat(activities.get(legacy.id, null).locationPoint()).isNull();
        for (Object[] pair : new Object[][] {{1, null}, {null, 1}, {181, 0}, {-181, 0}, {0, 91}, {0, -91}}) {
            assertThatThrownBy(() -> jdbc.update("UPDATE activities SET location_longitude=?,location_latitude=? WHERE id=?", pair[0], pair[1], legacy.id))
                .isInstanceOf(DataAccessException.class);
            assertThat(activities.get(legacy.id, null).locationPoint()).isNull();
        }
        jdbc.update("UPDATE activities SET location_longitude=-180,location_latitude=90 WHERE id=?", legacy.id);
        assertThat(activities.get(legacy.id, null).locationPoint()).isEqualTo(point("-180", "90"));
    }

    @Test void oldCreateMissingAndExplicitNullRemainCompatibleAndCompleteCoordinatesRoundOnlyAfterRangeValidation() throws Exception {
        for (boolean explicitNull : List.of(false, true)) {
            var body = createBody(); if (explicitNull) body.put("locationPoint", null);
            long id = postActivity(body);
            assertThat(activities.get(id, null).locationPoint()).isNull();
            assertAllProjections(id, account(), null);
        }
        var body = createBody(); body.put("locationPoint", Map.of("longitude", new BigDecimal("116.39742845"), "latitude", new BigDecimal("39.90923445")));
        long id = postActivity(body); assertThat(activities.get(id, null).locationPoint()).isEqualTo(POINT);
        assertAllProjections(id, account(), POINT);
        for (Object invalid : List.of(Map.of(), Map.of("longitude", 1), Map.of("longitude", 180.00000001, "latitude", 0),
            Map.of("longitude", 0, "latitude", -90.00000001), Map.of("longitude", "NaN", "latitude", 1))) {
            var rejected = createBody(); rejected.put("locationPoint", invalid);
            mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(rejected))).andExpect(status().isBadRequest());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, rejected.get("title"))).isZero();
        }
    }

    @Test void editMissingPreservesPointUntilTextChangesExplicitNullClearsAndReplacementWorks() throws Exception {
        long id = activity(POINT); var unchanged = editBody(id, "会场");
        long auditBefore = audit.search(1, 100, "ALL", id).total();
        patchActivity(id, unchanged); assertThat(activities.get(id, null).locationPoint()).isEqualTo(POINT);
        assertThat(audit.search(1, 100, "ALL", id).total()).isEqualTo(auditBefore);
        var changedText = editBody(id, "新会场"); patchActivity(id, changedText);
        assertThat(activities.get(id, null).locationPoint()).isNull();
        changedText.put("locationPoint", OTHER); patchActivity(id, changedText);
        assertThat(activities.get(id, null).locationPoint()).isEqualTo(OTHER);
        changedText.put("locationPoint", null); patchActivity(id, changedText);
        assertThat(activities.get(id, null).locationPoint()).isNull();
        changedText.put("locationPoint", POINT); patchActivity(id, changedText);
        assertThat(activities.get(id, null).locationPoint()).isEqualTo(POINT);
        // Old Service callers keep the original constructor and implicit-preserve behavior.
        assertThat(activities.edit(id, new EditActivityRequest(fixtureActivities.get(id), DESCRIPTION, "新会场"), adminId()).locationPoint()).isEqualTo(POINT);
    }

    @Test void coordinateOnlyEditAuditsExactStringsAtomicallyAndDoesNotMutateBusinessRowsOrExpandTheHotLock() {
        long id = activity(POINT), member = account(), waiter = account();
        registrations.register(id, member); registrations.register(id, waiter);
        var before = businessState(id); long events = audit.search(1, 100, "ALL", id).total();
        var observed = capture(() -> activities.edit(id, new EditActivityRequest(fixtureActivities.get(id), DESCRIPTION, "会场", "TECHNOLOGY", OTHER), adminId()));
        assertThat(businessState(id)).isEqualTo(before);
        assertThat(audit.search(1, 100, "ALL", id).total()).isEqualTo(events + 1);
        var edit = audit.search(1, 10, "EDIT", id).items().getFirst();
        assertThat(audit.detail(edit.id()).changes()).containsExactly(
            new AuditChange("locationLongitude", "116.3974285", "121.4737012"),
            new AuditChange("locationLatitude", "39.9092345", "31.2304167"));
        var created = audit.search(1, 10, "CREATE", id).items().getFirst();
        assertThat(audit.detail(created.id()).changes()).contains(new AuditChange("locationLongitude", null, "116.3974285"),
            new AuditChange("locationLatitude", null, "39.9092345"));
        assertThat(observed).filteredOn(query -> query.id().endsWith(".lockById")).singleElement().satisfies(query ->
            assertThat(query.sql().toLowerCase(Locale.ROOT)).contains("for update").doesNotContain("location", "longitude", "latitude", "description", "cover"));
        assertThat(observed).filteredOn(query -> query.id().endsWith(".auditText")).singleElement().satisfies(query ->
            assertThat(query.sql()).contains("location_longitude", "location_latitude").doesNotContain("FOR UPDATE"));
        assertThat(activities.get(id, member).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, waiter).registrationStatus()).isEqualTo("WAITING");
        activities.edit(id, new EditActivityRequest(fixtureActivities.get(id), DESCRIPTION, "会场", "TECHNOLOGY", OTHER), adminId());
        assertThat(audit.search(1, 100, "ALL", id).total()).isEqualTo(events + 1);
    }

    @Test void auditFailureRollsBackBothCoordinateCreateAndEdit() {
        String title = prefix + " rollback"; queries.failAudit.set(true);
        assertThatThrownBy(() -> activities.create(new CreateActivityRequest(title, DESCRIPTION, "会场", START, 1, "TECHNOLOGY", null, null, POINT), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        long id = activity(POINT); long events = audit.search(1, 100, "ALL", id).total(); queries.failAudit.set(true);
        assertThatThrownBy(() -> activities.edit(id, new EditActivityRequest(fixtureActivities.get(id), DESCRIPTION, "会场", "TECHNOLOGY", OTHER), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(activities.get(id, null).locationPoint()).isEqualTo(POINT);
        assertThat(audit.search(1, 100, "ALL", id).total()).isEqualTo(events);
    }

    @Test void coordinateWritesRetainAdminCsrfAndActivityLifecycleAuthorization() throws Exception {
        long id = activity(POINT); var body = editBody(id, "会场"); body.put("locationPoint", OTHER); long member = account();
        mvc.perform(patch("/api/admin/activities/" + id).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
            .andExpect(status().isUnauthorized());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(member))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
            .andExpect(status().isForbidden());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(activities.get(id, null).locationPoint()).isEqualTo(POINT);
        activities.cancel(id, new CancelActivityRequest("Owned location cancellation"), adminId());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CANCELLED"));
        var started = new NewActivity(prefix + " started", DESCRIPTION, "会场", LocalDateTime.ofInstant(NOW.minusSeconds(1), ZoneOffset.UTC), 1, adminId(),
            "TECHNOLOGY", null, null, POINT.longitude(), POINT.latitude());
        mapper.insert(started); fixtureActivities.put(started.id, started.title);
        assertThatThrownBy(() -> activities.edit(started.id, new EditActivityRequest(started.title, DESCRIPTION, "会场", "TECHNOLOGY", OTHER), adminId()))
            .isInstanceOfSatisfying(ApiException.class, failure -> assertThat(failure.code()).isEqualTo("ACTIVITY_CLOSED"));
        assertThat(activities.get(started.id, null).locationPoint()).isEqualTo(POINT);
    }

    @Test void coordinateProjectionKeepsExistingQueryCountsAndRepeatableReadSnapshots() {
        long id = activity(POINT), member = account(); registrations.register(id, member);
        favoriteKeys.add(new FavoriteKey(member, id)); favorites.add(member, id);
        long administrator = adminId();
        assertReadQueries(capture(() -> activities.search(1, 10, fixtureActivities.get(id), "ALL", member)), 2);
        assertReadQueries(capture(() -> admin.activities(1, 10, fixtureActivities.get(id), "ALL", administrator)), 2);
        assertReadQueries(capture(() -> registrations.mine(member)), 1);
        assertReadQueries(capture(() -> registrations.searchMine(member, 1, 10, "ALL")), 2);
        assertReadQueries(capture(() -> favorites.page(member, 1, 10)), 2);
    }

    @Test void anonymousMapConfigAndProxyUseProviderContractWithoutExposingSecretsOrQueryTermsInLogs(CapturedOutput output) throws Exception {
        mvc.perform(get("/api/maps/config")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.enabled").value(true)).andExpect(jsonPath("$.jsKey").value("a".repeat(32)))
            .andExpect(jsonPath("$.serviceHost").value("/api/_AMapService")).andExpect(jsonPath("$.securityCode").doesNotExist());
        mvc.perform(get("/api/_AMapService/v3/assistant/inputtips").param("keywords", "PRIVATE_LOCATION_SEARCH")
            .param("key", "PRIVATE_UNTRUSTED_KEY").header("Cookie", "PRIVATE_COOKIE").header("Authorization", "PRIVATE_AUTHORIZATION"))
            .andExpect(status().isOk()).andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andExpect(header().string("Cache-Control", "no-store")).andExpect(jsonPath("$.status").value("1"));
        assertThat(transport.last.get().getHost()).isEqualTo("restapi.amap.com");
        assertThat(transport.last.get().getRawQuery()).contains("key=" + "a".repeat(32), "jscode=" + "b".repeat(32)).doesNotContain("PRIVATE_UNTRUSTED_KEY");
        mvc.perform(get("/api/_AMapService/v3/place/text").param("jscode", "PRIVATE_INJECTED_SECRET"))
            .andExpect(status().isBadRequest());
        mvc.perform(get("/api/_AMapService/v3/direction/driving")).andExpect(status().isNotFound());
        assertThat(output.getAll()).doesNotContain("b".repeat(32), "PRIVATE_LOCATION_SEARCH", "PRIVATE_UNTRUSTED_KEY", "PRIVATE_COOKIE", "PRIVATE_AUTHORIZATION", "PRIVATE_INJECTED_SECRET");
    }

    private void assertAllProjections(long id, long member, LocationPoint point) throws Exception {
        assertThat(registrations.register(id, member).locationPoint()).isEqualTo(point);
        favoriteKeys.add(new FavoriteKey(member, id)); favorites.add(member, id);
        for (String path : List.of("/api/activities/" + id, "/api/activities", "/api/activities/search", "/api/admin/activities",
            "/api/admin/activities/" + id + "/registrations", "/api/me/registrations", "/api/me/registrations/search", "/api/me/favorites")) {
            var request = get(path);
            if (path.startsWith("/api/admin")) request.with(user(principal(adminId())));
            else if (path.startsWith("/api/me")) request.with(user(principal(member)));
            if (path.equals("/api/activities/search") || path.equals("/api/admin/activities")) request.param("keyword", fixtureActivities.get(id));
            var response = json.readTree(mvc.perform(request).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            if (response.has("id")) assertJsonPoint(response, point);
            else if (response.has("activity")) assertJsonPoint(response.get("activity"), point);
            else {
                boolean found = false;
                for (var item : response.isArray() ? response : response.get("items")) {
                    var activity = item.has("activity") ? item.get("activity") : item;
                    if (activity.get("id").asLong() == id) { assertJsonPoint(activity, point); found = true; }
                }
                assertThat(found).as(path).isTrue();
            }
        }
        assertThat(registrations.cancel(id, member).locationPoint()).isEqualTo(point);
    }
    private void assertJsonPoint(JsonNode activity, LocationPoint point) {
        assertThat(activity.has("locationPoint")).isTrue();
        if (point == null) assertThat(activity.get("locationPoint").isNull()).isTrue();
        else {
            assertThat(activity.get("locationPoint").get("longitude").isNumber()).isTrue();
            assertThat(json.treeToValue(activity.get("locationPoint"), LocationPoint.class)).isEqualTo(point);
        }
    }
    private void assertReadQueries(List<Query> observed, int expected) {
        assertThat(observed).hasSize(expected).allSatisfy(query -> {
            assertThat(query.readOnly()).isTrue(); assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        });
    }
    private List<Query> capture(Runnable action) {
        var observed = new ArrayList<Query>(); queries.captured.set(observed);
        try { action.run(); } finally { queries.captured.remove(); } return observed;
    }
    private Map<String, Object> businessState(long id) {
        return Map.of("activity", jdbc.queryForMap("SELECT starts_at,ends_at,registration_deadline,capacity,registered_count,category,cover_hash,cancelled_at FROM activities WHERE id=?", id),
            "registrations", jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", id),
            "notifications", jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", id));
    }
    private long postActivity(Map<String, Object> body) throws Exception {
        var result = mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isCreated()).andReturn();
        long id = json.readTree(result.getResponse().getContentAsString()).get("id").asLong(); fixtureActivities.put(id, (String) body.get("title")); return id;
    }
    private void patchActivity(long id, Map<String, Object> body) throws Exception {
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isOk());
    }
    private Map<String, Object> createBody() {
        var body = new LinkedHashMap<String, Object>(); body.put("title", prefix + " " + UUID.randomUUID()); body.put("description", DESCRIPTION);
        body.put("location", "会场"); body.put("startsAt", START.toString()); body.put("capacity", 1); return body;
    }
    private Map<String, Object> editBody(long id, String location) {
        var body = new LinkedHashMap<String, Object>(); body.put("title", fixtureActivities.get(id)); body.put("description", DESCRIPTION); body.put("location", location); return body;
    }
    private long activity(LocationPoint point) {
        String title = prefix + " " + fixtureActivities.size();
        long id = activities.create(new CreateActivityRequest(title, DESCRIPTION, "会场", START, 1, "TECHNOLOGY", null, null, point), adminId()).id();
        fixtureActivities.put(id, title); return id;
    }
    private long account() {
        String username = "location_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "地图专项用户", "USER");
        long id = users.findByUsername(username).id(); fixtureUsers.put(id, username); return id;
    }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocationPoint point(String longitude, String latitude) { return new LocationPoint(new BigDecimal(longitude), new BigDecimal(latitude)); }
}

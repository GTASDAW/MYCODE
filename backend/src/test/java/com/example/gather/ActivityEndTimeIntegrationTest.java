package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.api.AdminModels.RosterView;
import com.example.gather.api.AuditLogModels.AuditChange;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.*;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Dedicated real MySQL: microsecond boundaries, additive API compatibility and late check-in. */
@SpringBootTest
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ActivityEndTimeIntegrationTest.Configuration.class)
class ActivityEndTimeIntegrationTest {
    static final Instant NOW = Instant.parse("2046-10-01T09:00:00.123456Z");
    static final Instant START = NOW.plusSeconds(3600);
    static final Instant END = START.plusSeconds(3600);

    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return time.get(); }
    }
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary MutableClock endTimeClock() { return new MutableClock(); }
        @Bean EndTimeQueries endTimeQueries() { return new EndTimeQueries(); }
    }
    @Intercepts({@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})})
    static class EndTimeQueries implements Interceptor {
        final AtomicBoolean failAudit = new AtomicBoolean();
        final List<String> lockSql = new ArrayList<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (statement.getId().endsWith("AuditLogMapper.insert") && failAudit.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected end time audit failure");
            if (statement.getId().endsWith("ActivityMapper.lockById"))
                lockSql.add(statement.getBoundSql(invocation.getArgs()[1]).getSql());
            return invocation.proceed();
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("End time tests require dedicated real MySQL activity_platform_test");
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
    @Autowired CheckInService checkIns;
    @Autowired AuditLogService audit;
    @Autowired MutableClock clock;
    @Autowired EndTimeQueries queries;
    final Map<Long, String> fixtureActivities = new LinkedHashMap<>();
    final Map<Long, String> fixtureUsers = new LinkedHashMap<>();
    final List<FavoriteKey> favoriteKeys = new ArrayList<>();
    final String prefix = "End time " + UUID.randomUUID();

    @BeforeEach void gate() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(11);
        jdbc.queryForList("SELECT id,category,cover_hash,cover_image,ends_at FROM activities LIMIT 0");
        clock.time.set(NOW);
    }
    @AfterEach void cleanup() {
        clock.time.set(NOW); queries.failAudit.set(false); queries.lockSql.clear();
        fixtureActivities.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        fixtureUsers.forEach((id, username) -> assertThat(users.findById(id).username()).isEqualTo(username));
        OwnedIntegrationFixtures.remove(jdbc, fixtureActivities.keySet(), fixtureUsers.keySet(), favoriteKeys);
    }

    @Test void migrationHasNullableMicrosecondsAndDatabaseConstraintWithoutInventingAnEnd() {
        var columns = jdbc.queryForMap("SELECT IS_NULLABLE, DATETIME_PRECISION FROM information_schema.COLUMNS "
            + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='activities' AND COLUMN_NAME='ends_at'");
        assertThat(columns.get("IS_NULLABLE")).isEqualTo("YES");
        assertThat(((Number) columns.get("DATETIME_PRECISION")).intValue()).isEqualTo(6);
        var legacy = new NewActivity(prefix, "Legacy request fixture", "会场", utc(START), 2, adminId());
        mapper.insert(legacy); fixtureActivities.put(legacy.id, legacy.title);
        assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        for (Instant invalid : List.of(START, START.minusNanos(1000))) {
            assertThatThrownBy(() -> jdbc.update("UPDATE activities SET ends_at=? WHERE id=?", utc(invalid), legacy.id))
                .isInstanceOf(DataAccessException.class);
            assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        }
        jdbc.update("UPDATE activities SET ends_at=? WHERE id=?", utc(START.plusNanos(1000)), legacy.id);
        assertThat(activities.get(legacy.id, null).endsAt()).isEqualTo(START.plusNanos(1000));
        jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?", legacy.id);
        clock.time.set(END.plusSeconds(1));
        assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        assertThat(activities.get(legacy.id, null).closed()).isTrue();
    }

    @Test void oldRequestsWithMissingOrExplicitNullEndKeepLegacyFieldsAndNullEndInEveryProjection() throws Exception {
        long member = account();
        for (boolean explicitNull : List.of(false, true)) {
            var body = body(prefix + " null " + explicitNull, START.toString());
            if (explicitNull) body.put("endsAt", null);
            long id = postActivity(body);
            assertThat(activities.get(id, null).endsAt()).isNull();
            assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
            assertThat(activities.get(id, null).capacity()).isEqualTo(2);
            assertProjectionEnds(id, member, null);
            assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
                .contains(new AuditChange("endsAt", null, null));
        }
    }

    @Test void invalidEndAndSubMicrosecondEqualityFailBeforeWritingActivityOrAudit() throws Exception {
        for (Instant invalid : List.of(START.minusSeconds(1), START, START.plusNanos(999))) {
            String title = prefix + " invalid " + invalid;
            var body = body(title, START.toString()); body.put("endsAt", invalid.toString());
            mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_title=?", Integer.class, title)).isZero();
        }
        var minimum = body(prefix + " first microsecond", START.plusNanos(700).toString());
        minimum.put("endsAt", START.plusNanos(1000).toString());
        long id = postActivity(minimum);
        assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
        assertThat(activities.get(id, null).endsAt()).isEqualTo(START.plusNanos(1000));
    }

    @Test void offsetInputPersistsAndAuditsExactlyTheUtcMicrosecondsAcrossAllJoinedResponses() throws Exception {
        var body = body(prefix + " offsets", START.atOffset(ZoneOffset.ofHours(8)).toString());
        body.put("endsAt", END.plusNanos(987).atOffset(ZoneOffset.ofHours(-5)).toString());
        long id = postActivity(body);
        assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
        assertThat(activities.get(id, null).endsAt()).isEqualTo(END);
        assertThat(jdbc.queryForObject("SELECT ends_at FROM activities WHERE id=?", LocalDateTime.class, id)).isEqualTo(utc(END));
        assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
            .contains(new AuditChange("startsAt", null, START.toString()), new AuditChange("endsAt", null, END.toString()));
        assertProjectionEnds(id, account(), END);
    }

    @Test void createStillRequiresAdminAndCsrfAndNeverTrustsClientIdentity() throws Exception {
        String title = prefix + " permission";
        var body = body(title, START.toString()); body.put("endsAt", END.toString());
        String text = json.writeValueAsString(body); long member = account();
        mvc.perform(post("/api/admin/activities").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(text)).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/admin/activities").with(user(principal(member))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(text)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).contentType(MediaType.APPLICATION_JSON).content(text))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        body.put("createdBy", member);
        long id = postActivity(body);
        assertThat(jdbc.queryForObject("SELECT created_by FROM activities WHERE id=?", Long.class, id)).isEqualTo(adminId());
    }

    @Test void endRemainsFixedDuringEditAndCancelAndRepeatedCancellation() throws Exception {
        long id = activity(END);
        var edit = new LinkedHashMap<String, Object>();
        edit.put("title", fixtureActivities.get(id)); edit.put("description", "New description"); edit.put("location", "新会场");
        edit.put("endsAt", END.plusSeconds(9999).toString()); edit.put("startsAt", START.plusSeconds(60).toString());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(edit)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.endsAt").value(END.toString())).andExpect(jsonPath("$.startsAt").value(START.toString()));
        var first = activities.cancel(id, new CancelActivityRequest("原始取消原因"), adminId());
        clock.time.set(END.plusSeconds(1));
        var repeated = activities.cancel(id, new CancelActivityRequest("后来的取消原因"), adminId());
        assertThat(repeated).isEqualTo(first);
        assertThat(repeated.endsAt()).isEqualTo(END);
        assertThat(repeated.cancelled()).isTrue();
        assertThat(audit.search(1, 10, "CANCEL", id).total()).isEqualTo(1);
    }

    @Test void startedFilterAndClosedBoundaryStayCompatibleAndEndedActivityAllowsIdempotentAdminCheckIn() throws Exception {
        long id = activity(END), member = account(), other = account();
        registrations.register(id, member);
        long registration = jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, id, member);
        String checkIn = "/api/admin/activities/" + id + "/registrations/" + registration + "/check-in";
        clock.time.set(START.minusNanos(1));
        assertThat(activities.get(id, null).closed()).isFalse();
        mvc.perform(post(checkIn).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("CHECK_IN_NOT_OPEN"));
        clock.time.set(START);
        assertThat(activities.get(id, null).closed()).isTrue();
        assertThat(activities.search(1, 10, prefix, "STARTED", null).items()).extracting(ActivityView::id).containsExactly(id);
        mvc.perform(post("/api/activities/" + id + "/registration").with(user(principal(other))).with(csrf()))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CLOSED"));
        clock.time.set(END.plusSeconds(86400));
        assertThat(activities.search(1, 10, prefix, "STARTED", null).items()).extracting(ActivityView::id).containsExactly(id);
        mvc.perform(post(checkIn).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(post(checkIn).with(user(principal(member))).with(csrf())).andExpect(status().isForbidden());
        mvc.perform(post(checkIn).with(user(principal(adminId())))).andExpect(status().isForbidden());
        var before = jdbc.queryForMap("SELECT status,updated_at FROM registrations WHERE id=?", registration);
        var first = json.readValue(mvc.perform(post(checkIn).with(user(principal(adminId()))).with(csrf()))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(), RosterView.class);
        clock.time.set(END.plusSeconds(172800));
        assertThat(checkIns.checkIn(id, registration, adminId())).isEqualTo(first);
        assertThat(first.checkedInAt()).isEqualTo(END.plusSeconds(86400));
        assertThat(jdbc.queryForMap("SELECT status,updated_at FROM registrations WHERE id=?", registration)).isEqualTo(before);
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        assertThat(audit.search(1, 10, "CHECK_IN", id).total()).isEqualTo(1);
        assertThat(queries.lockSql).isNotEmpty().allSatisfy(sql -> assertThat(sql.toLowerCase(Locale.ROOT))
            .contains("for update").doesNotContain("ends_at", "description", "cover_image"));
    }

    @Test void auditFailureRollsBackNewEndTimeActivityInTheSameTransaction() {
        String title = prefix + " rollback"; queries.failAudit.set(true);
        assertThatThrownBy(() -> activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, 2, "TECHNOLOGY", END), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_title=?", Integer.class, title)).isZero();
    }

    private void assertProjectionEnds(long id, long member, Instant end) throws Exception {
        assertThat(registrations.register(id, member).endsAt()).isEqualTo(end);
        assertThat(registrations.register(id, member).registeredCount()).isEqualTo(1);
        favoriteKeys.add(new FavoriteKey(member, id)); favorites.add(member, id);
        var detail = mvc.perform(get("/api/activities/" + id)).andExpect(status().isOk()).andReturn();
        assertJsonEnd(json.readTree(detail.getResponse().getContentAsString()), end);
        var oldList = json.readTree(mvc.perform(get("/api/activities")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        boolean found = false;
        for (var item : oldList) if (item.get("id").asLong() == id) { assertJsonEnd(item, end); found = true; }
        assertThat(found).isTrue();
        var search = activities.search(1, 10, fixtureActivities.get(id), "ALL", null);
        assertThat(search.items()).singleElement().satisfies(item -> assertThat(item.endsAt()).isEqualTo(end));
        for (String path : List.of("/api/admin/activities",
            "/api/admin/activities/" + id + "/registrations", "/api/me/registrations", "/api/me/registrations/search", "/api/me/favorites")) {
            boolean admin = path.startsWith("/api/admin");
            var request = get(path).with(user(principal(admin ? adminId() : member)));
            if (path.equals("/api/admin/activities")) request.param("keyword", fixtureActivities.get(id));
            var result = mvc.perform(request).andExpect(status().isOk()).andReturn();
            if (path.equals("/api/admin/activities")) assertThat(result.getRequest().getParameter("keyword")).isEqualTo(fixtureActivities.get(id));
            var response = json.readTree(result.getResponse().getContentAsString());
            if (path.contains("/registrations") && admin) assertJsonEnd(response.get("activity"), end);
            else {
                var items = response.isArray() ? response : response.get("items");
                boolean projected = false;
                for (var item : items) {
                    var activity = item.has("activity") ? item.get("activity") : item;
                    if (activity.get("id").asLong() == id) { assertJsonEnd(activity, end); projected = true; }
                }
                assertThat(projected).as(path).isTrue();
            }
        }
        assertThat(registrations.cancel(id, member).endsAt()).isEqualTo(end);
    }
    private void assertJsonEnd(tools.jackson.databind.JsonNode item, Instant end) {
        assertThat(item.has("endsAt")).isTrue();
        if (end == null) assertThat(item.get("endsAt").isNull()).isTrue();
        else assertThat(item.get("endsAt").asText()).isEqualTo(end.toString());
    }
    private long postActivity(Map<String, Object> body) throws Exception {
        var response = mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isCreated()).andReturn();
        long id = json.readTree(response.getResponse().getContentAsString()).get("id").asLong();
        fixtureActivities.put(id, (String) body.get("title")); return id;
    }
    private long activity(Instant end) {
        String title = prefix + " " + fixtureActivities.size();
        long id = activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, 2, "TECHNOLOGY", end), adminId()).id();
        fixtureActivities.put(id, title); return id;
    }
    private Map<String, Object> body(String title, String start) {
        var body = new LinkedHashMap<String, Object>(); body.put("title", title); body.put("description", "Owned end fixture");
        body.put("location", "北京时间会场"); body.put("startsAt", start); body.put("capacity", 2); return body;
    }
    private long account() {
        String username = "end_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "结束时间专项用户", "USER");
        long id = users.findByUsername(username).id(); fixtureUsers.put(id, username); return id;
    }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC); }
}

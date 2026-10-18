package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.api.AuditLogModels.AuditChange;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.AuditLogService;
import com.example.gather.service.RegistrationService;
import com.example.gather.support.OwnedIntegrationFixtures;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.mapping.SqlCommandType;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** V8 constraints, compatibility, category snapshots and exact real MySQL query counts. */
@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ActivityCategoryIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ActivityCategoryIntegrationTest {
    private static final Instant NOW = Instant.parse("2045-10-01T09:00:00.123456789Z");
    private static final List<String> CATEGORIES = List.of("UNCATEGORIZED", "TECHNOLOGY", "SPORTS", "CULTURE", "OTHER");
    private static final String VERSION = "com.example.gather.mapper.CredentialVersionMapper.findByUserId";
    private static final String AUDIT_INSERT = "com.example.gather.mapper.AuditLogMapper.insert";
    private static final String DESCRIPTION = "Activity category integration fixture";

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary CategoryClock categoryClock() { return new CategoryClock(); }
        @Bean CategoryQueries categoryQueries() { return new CategoryQueries(); }
    }
    static class CategoryClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return NOW; }
    }
    record Query(String id, String sql, List<Object> parameters, boolean readOnly, Integer isolation) {}
    record Hook(String id, Runnable after) {}
    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class CategoryQueries implements Interceptor {
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        final AtomicReference<Hook> hook = new AtomicReference<>();
        final AtomicBoolean failAudit = new AtomicBoolean();
        final AtomicLong insertedActivity = new AtomicLong();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (captured.get() != null) {
                Object input = invocation.getArgs()[1];
                var bound = statement.getBoundSql(input);
                List<Object> values = new ArrayList<>();
                var parameters = statement.getConfiguration().newMetaObject(input);
                for (var mapping : bound.getParameterMappings()) {
                    String name = mapping.getProperty();
                    values.add(bound.hasAdditionalParameter(name) ? bound.getAdditionalParameter(name)
                        : input != null && statement.getConfiguration().getTypeHandlerRegistry().hasTypeHandler(input.getClass()) ? input
                        : parameters.getValue(name));
                }
                captured.get().add(new Query(statement.getId(), bound.getSql(), values,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(), TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            if (statement.getId().equals(AUDIT_INSERT) && failAudit.getAndSet(false)) throw new DataAccessResourceFailureException("Injected category audit failure");
            Object result = invocation.proceed();
            if (statement.getId().equals(ActivityMapper.class.getName() + ".insert")) insertedActivity.set(((NewActivity) invocation.getArgs()[1]).id);
            Hook next = hook.get();
            if (next != null && next.id().equals(statement.getId()) && hook.compareAndSet(next, null)) next.after().run();
            return result;
        }
    }

    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Activity category tests require dedicated REAL activity_platform_test MySQL");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!"); properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }
    private static String environment(String key, String fallback) { return System.getenv(key) == null ? fallback : System.getenv(key); }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ActivityService activities;
    @Autowired ActivityMapper activityMapper;
    @Autowired AdminService admin;
    @Autowired UserMapper users;
    @Autowired RegistrationService registrations;
    @Autowired AuditLogService audit;
    @Autowired ObjectMapper json;
    @Autowired CategoryClock clock;
    @Autowired CategoryQueries reads;
    private final Map<Long, String> activityFixtures = new LinkedHashMap<>();
    private final Map<Long, String> userFixtures = new LinkedHashMap<>();
    private final String prefix = "Category " + UUID.randomUUID();

    @BeforeEach void verifyCurrentSchemaBeforeWrites() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(10);
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image FROM activities LIMIT 0"); jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
    }
    @AfterEach void cleanOnlyOwnedFixtures() {
        reads.captured.remove(); reads.hook.set(null); reads.failAudit.set(false);
        activityFixtures.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        userFixtures.forEach((id, name) -> assertThat(users.findById(id).username()).isEqualTo(name));
        OwnedIntegrationFixtures.remove(jdbc, activityFixtures.keySet(), userFixtures.keySet());
    }

    @Test void schemaDefaultsAndBinaryConstraintRejectNullUnknownCaseAndWhitespaceVariants() {
        var row = new NewActivity(prefix, DESCRIPTION, "会场", utc(NOW.plusSeconds(3600)), 2, adminId());
        var keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var insert = connection.prepareStatement("INSERT INTO activities(title,description,location,starts_at,capacity,created_by) VALUES(?,?,?,?,?,?)",
                java.sql.Statement.RETURN_GENERATED_KEYS);
            insert.setString(1, row.title); insert.setString(2, row.description); insert.setString(3, row.location);
            insert.setTimestamp(4, java.sql.Timestamp.valueOf(row.startsAt)); insert.setInt(5, row.capacity); insert.setLong(6, row.createdBy);
            return insert;
        }, keys);
        row.id = Objects.requireNonNull(keys.getKey()).longValue(); activityFixtures.put(row.id, row.title);
        assertThat(activities.get(row.id, null).category()).isEqualTo("UNCATEGORIZED");
        for (String invalid : List.of("", "ALL", "UNKNOWN", "technology", "TECHNOLOGY ", " TECHNOLOGY", "科技")) {
            assertThatThrownBy(() -> jdbc.update("UPDATE activities SET category=? WHERE id=?", invalid, row.id)).isInstanceOf(DataAccessException.class);
            assertThat(activities.get(row.id, null).category()).isEqualTo("UNCATEGORIZED");
        }
        assertThatThrownBy(() -> jdbc.update("UPDATE activities SET category=NULL WHERE id=?", row.id)).isInstanceOf(DataAccessException.class);
        for (String category : CATEGORIES) {
            jdbc.update("UPDATE activities SET category=? WHERE id=?", category, row.id);
            assertThat(activities.get(row.id, null).category()).isEqualTo(category);
        }
    }

    @Test void oldCreateMissingAndNullDefaultWhileOldEditMissingAndNullPreserveCategory() throws Exception {
        for (boolean explicitNull : List.of(false, true)) {
            var request = createBody(prefix + " " + explicitNull, null); if (!explicitNull) request.remove("category");
            var result = mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request))).andReturn();
            long id = json.readTree(result.getResponse().getContentAsString()).get("id").asLong(); activityFixtures.put(id, (String) request.get("title"));
            assertThat(result.getResponse().getStatus()).isEqualTo(201);
            assertThat(activities.get(id, null).category()).isEqualTo("UNCATEGORIZED");
            activities.edit(id, edit(id, "TECHNOLOGY"), adminId());
            var patch = editBody(id, null); if (!explicitNull) patch.remove("category");
            mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(patch)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.category").value("TECHNOLOGY"));
            assertThat(audit.search(1, 10, "EDIT", id).total()).isEqualTo(1);
        }
    }

    @Test void everyCategoryAppearsInPublicLegacyDetailPagedWritesRosterAndPersonalEmbeddedActivity() throws Exception {
        long member = createUser();
        for (String category : CATEGORIES) {
            long id = create(category, 2);
            mvc.perform(get("/api/activities/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.category").value(category));
            mvc.perform(post("/api/activities/" + id + "/registration").with(user(principal(member))).with(csrf()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.category").value(category));
            mvc.perform(get("/api/admin/activities/" + id + "/registrations").with(user(principal(adminId()))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.activity.category").value(category));
        }
        var oldPublic = json.readTree(mvc.perform(get("/api/activities")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        Set<String> seen = new HashSet<>();
        oldPublic.forEach(item -> { if (activityFixtures.containsKey(item.get("id").asLong())) seen.add(item.get("category").asString()); });
        assertThat(seen).containsExactlyInAnyOrderElementsOf(CATEGORIES);
        for (String path : List.of("/api/me/registrations", "/api/me/registrations/search")) {
            var body = json.readTree(mvc.perform(get(path).with(user(principal(member)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            var items = path.endsWith("search") ? body.get("items") : body;
            Set<String> categories = new HashSet<>(); items.forEach(item -> categories.add(item.get("activity").get("category").asString()));
            assertThat(categories).containsExactlyInAnyOrderElementsOf(CATEGORIES);
        }
        var publicPage = activities.search(1, 100, prefix, "ALL", "ALL", null);
        assertThat(publicPage.items()).extracting(ActivityView::category).containsExactlyInAnyOrderElementsOf(CATEGORIES);
        assertThat(admin.activities(1, 100, prefix, "ALL", "ALL", adminId()).items()).extracting(ActivityView::category)
            .containsExactlyInAnyOrderElementsOf(CATEGORIES);
    }

    @Test void invalidCategoryCreateEditAndFiltersReturn400AndNeverWriteOrAppendAudit() throws Exception {
        long id = create("SPORTS", 2); var before = state(id); var principal = principal(adminId());
        for (String invalid : List.of("", "ALL", "UNKNOWN", "technology", "TECHNOLOGY ", " 科技")) {
            mvc.perform(post("/api/admin/activities").with(user(principal)).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(createBody(prefix + " invalid", invalid))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            mvc.perform(patch("/api/admin/activities/" + id).with(user(principal)).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(editBody(id, invalid))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            if (!invalid.equals("ALL")) for (String path : List.of("/api/activities/search", "/api/admin/activities")) {
                mvc.perform(get(path).with(user(principal)).param("category", invalid)).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            }
        }
        assertThat(state(id)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE LOCATE(?,title)>0", Integer.class, prefix)).isEqualTo(1);
    }

    @Test void categoryKeywordAndStatusUseAndWithFullFilteredSummary() {
        long open = create("TECHNOLOGY", 4); long full = create("TECHNOLOGY", 1);
        long started = create("TECHNOLOGY", 2); long cancelled = create("TECHNOLOGY", 3); create("SPORTS", 100);
        long member = createUser(); registrations.register(open, member); registrations.register(full, member);
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(NOW), started);
        activities.cancel(cancelled, new CancelActivityRequest("独立分类样例取消"), adminId());
        assertThat(activities.search(1, 10, prefix, "ALL", "TECHNOLOGY", null).summary()).isEqualTo(new ActivitySearchSummary(2, 3));
        assertThat(activities.search(1, 10, prefix, "ALL", "TECHNOLOGY", null).total()).isEqualTo(4);
        for (var entry : Map.of("OPEN", List.of(open), "FULL", List.of(full), "STARTED", List.of(started),
                "CANCELLED", List.of(cancelled), "UPCOMING", List.of(open, full)).entrySet()) {
            var page = activities.search(1, 10, prefix, entry.getKey(), "TECHNOLOGY", null);
            assertThat(page.items()).extracting(ActivityView::id).containsExactlyElementsOf(entry.getValue());
            assertThat(admin.activities(1, 10, prefix, entry.getKey(), "TECHNOLOGY", adminId()).items()).isEqualTo(page.items());
        }
        assertThat(activities.search(1, 10, prefix + " does not match", "ALL", "TECHNOLOGY", null).total()).isZero();
        assertThat(activities.search(1, 10, prefix, "ALL", "CULTURE", null).total()).isZero();
    }

    @Test void literalKeywordAndCategoryRemainIndependentAndSqlCharactersAreNotWildcards() {
        long literal = create("CULTURE", 3);
        String name = activityFixtures.get(literal);
        jdbc.update("UPDATE activities SET location=? WHERE id=?", prefix + " location%_", literal);
        long other = create("OTHER", 99);
        jdbc.update("UPDATE activities SET location=? WHERE id=?", prefix + " location%_", other);
        assertThat(activities.search(1, 10, "location%_", "OPEN", "CULTURE", null).items()).extracting(ActivityView::id).containsExactly(literal);
        assertThat(activities.search(1, 10, "locationXX", "ALL", "CULTURE", null).items()).isEmpty();
        assertThat(activities.search(1, 10, "x' OR 1=1 --", "ALL", "CULTURE", null).items()).isEmpty();
        assertThat(activities.get(literal, null).title()).isEqualTo(name);
    }

    @Test void stablePaginationAndOutOfRangeKeepFullCategoryTotalsAndAvailableSeats() {
        List<Long> expected = new ArrayList<>();
        for (int capacity = 1; capacity <= 5; capacity++) expected.add(create("SPORTS", capacity));
        create("OTHER", 100);
        for (int page = 1; page <= 3; page++) {
            var result = activities.search(page, 2, prefix, "OPEN", "SPORTS", null);
            assertThat(result.total()).isEqualTo(5); assertThat(result.summary()).isEqualTo(new ActivitySearchSummary(5, 15));
            assertThat(result.items()).extracting(ActivityView::id).containsExactlyElementsOf(expected.subList((page - 1) * 2, Math.min(page * 2, 5)));
            assertThat(admin.activities(page, 2, prefix, "OPEN", "SPORTS", adminId()).items()).isEqualTo(result.items());
        }
        var outside = activities.search(Integer.MAX_VALUE, 100, prefix, "ALL", "SPORTS", null);
        assertThat(outside.total()).isEqualTo(5); assertThat(outside.items()).isEmpty(); assertThat(outside.summary().availableSeats()).isEqualTo(15);
    }

    @Test void categoryOnlyEditAuditsExactBeforeAfterAndNoopKeepsAllOriginalBusinessRows() throws Exception {
        long id = create("TECHNOLOGY", 2); long member = createUser(); registrations.register(id, member);
        var before = activities.get(id, null); var registrationsBefore = jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=?", id);
        var changes = capture(() -> activities.edit(id, edit(id, "CULTURE"), adminId()));
        var after = activities.get(id, null);
        assertThat(after.category()).isEqualTo("CULTURE"); assertThat(after.title()).isEqualTo(before.title());
        assertThat(after.startsAt()).isEqualTo(before.startsAt()); assertThat(after.capacity()).isEqualTo(before.capacity());
        assertThat(after.registeredCount()).isEqualTo(before.registeredCount());
        assertThat(jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=?", id)).isEqualTo(registrationsBefore);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        var event = audit.detail(audit.search(1, 10, "EDIT", id).items().getFirst().id());
        assertThat(event.changes()).containsExactly(new AuditChange("category", "TECHNOLOGY", "CULTURE"));
        assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
            .contains(new AuditChange("category", null, "TECHNOLOGY"));
        assertThat(changes).filteredOn(query -> query.id().endsWith(".lockById")).singleElement().satisfies(query ->
            assertThat(query.sql().toLowerCase(Locale.ROOT)).contains("for update").doesNotContain("category", "description", "title", "location"));
        assertThat(changes).filteredOn(query -> query.id().endsWith(".auditText")).singleElement().satisfies(query -> assertThat(query.sql()).contains("category"));
        var noop = capture(() -> {
            activities.edit(id, edit(id, "CULTURE"), adminId()); activities.edit(id, edit(id, null), adminId());
        });
        assertThat(noop).noneMatch(query -> query.id().equals(ActivityMapper.class.getName() + ".edit") || query.id().equals(AUDIT_INSERT));
        assertThat(audit.search(1, 10, "EDIT", id).total()).isEqualTo(1);
    }

    @Test void categoryEditRequiresAdminAndCsrfAndDoesNotUnlockClosedActivities() throws Exception {
        long id = create("TECHNOLOGY", 2); long member = createUser(); String body = json.writeValueAsString(editBody(id, "SPORTS"));
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(member))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(activities.get(id, null).category()).isEqualTo("TECHNOLOGY");
        activities.cancel(id, new CancelActivityRequest("取消分类样例"), adminId());
        assertThatThrownBy(() -> activities.edit(id, edit(id, "SPORTS"), adminId())).isInstanceOfSatisfying(ApiException.class,
            failure -> assertThat(failure.code()).isEqualTo("ACTIVITY_CANCELLED"));
        long started = create("TECHNOLOGY", 2); jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(NOW), started);
        assertThatThrownBy(() -> activities.edit(started, edit(started, "SPORTS"), adminId())).isInstanceOfSatisfying(ApiException.class,
            failure -> assertThat(failure.code()).isEqualTo("ACTIVITY_CLOSED"));
        assertThat(audit.search(1, 10, "EDIT", id).total()).isZero(); assertThat(audit.search(1, 10, "EDIT", started).total()).isZero();
    }

    @Test void failedAuditRollsBackCategoryEditAndCategorizedCreateTogether() {
        long id = create("TECHNOLOGY", 2); var before = state(id); reads.failAudit.set(true);
        assertThatThrownBy(() -> activities.edit(id, edit(id, "OTHER"), adminId())).isInstanceOf(DataAccessException.class);
        assertThat(state(id)).isEqualTo(before);
        reads.failAudit.set(true);
        assertThatThrownBy(() -> activities.create(new CreateActivityRequest(prefix + " failed", DESCRIPTION, "会场", NOW.plusSeconds(3600), 1, "CULTURE"), adminId()))
            .isInstanceOf(DataAccessException.class);
        long failedId = reads.insertedActivity.get();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id=?", Integer.class, failedId)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_id=?", Integer.class, failedId)).isZero();
    }

    @Test void publicAndAdminCategoryReadsShareRepeatableSnapshotsAcrossConcurrentCategoryChanges() {
        long first = create("TECHNOLOGY", 2);
        reads.hook.set(new Hook(ActivityMapper.class.getName() + ".searchTotals", () -> inOtherThread(() -> activities.edit(first, edit(first, "SPORTS"), adminId()))));
        var publicSnapshot = activities.search(1, 10, prefix, "ALL", "TECHNOLOGY", null);
        assertThat(publicSnapshot.total()).isEqualTo(1); assertThat(publicSnapshot.summary()).isEqualTo(new ActivitySearchSummary(1, 2));
        assertThat(publicSnapshot.items()).singleElement().satisfies(item -> assertThat(item.category()).isEqualTo("TECHNOLOGY"));
        assertThat(activities.search(1, 10, prefix, "ALL", "TECHNOLOGY", null).total()).isZero();
        long second = create("TECHNOLOGY", 3);
        reads.hook.set(new Hook(AdminMapper.class.getName() + ".countActivities", () -> inOtherThread(() -> activities.edit(second, edit(second, "OTHER"), adminId()))));
        var adminSnapshot = admin.activities(1, 10, prefix, "ALL", "TECHNOLOGY", adminId());
        assertThat(adminSnapshot.total()).isEqualTo(1); assertThat(adminSnapshot.items()).singleElement().satisfies(item -> assertThat(item.category()).isEqualTo("TECHNOLOGY"));
        assertThat(admin.activities(1, 10, prefix, "ALL", "TECHNOLOGY", adminId()).total()).isZero();
    }

    @Test void singleClockAndTwoBusinessSelectsArePreservedWhilePersonalHttpReadsAddOnlyOneAuthenticationSelect() throws Exception {
        long id = create("CULTURE", 3); long member = createUser(); registrations.register(id, member);
        var adminPrincipal = principal(adminId()); var memberPrincipal = principal(member);
        clock.calls.set(0);
        var publicQueries = capture(() -> activities.search(1, 10, prefix, "ALL", "CULTURE", null));
        assertThat(clock.calls).hasValue(1);
        assertThat(publicQueries).extracting(Query::id).containsExactly(ActivityMapper.class.getName() + ".searchTotals", ActivityMapper.class.getName() + ".search");
        assertSnapshot(publicQueries);
        clock.calls.set(0);
        var adminQueries = captureHttp(() -> mvc.perform(get("/api/admin/activities").with(user(adminPrincipal)).param("category", "CULTURE").param("keyword", prefix)).andExpect(status().isOk()));
        assertThat(clock.calls).hasValue(1); assertThat(adminQueries).extracting(Query::id).containsExactly(VERSION,
            AdminMapper.class.getName() + ".countActivities", AdminMapper.class.getName() + ".activities");
        assertSnapshot(adminQueries.subList(1, 3));
        var evidence = new StringBuilder("# Activity category query evidence\n\n")
            .append("Dedicated MySQL activity_platform_test; schema V10; MySQL ").append(jdbc.queryForObject("SELECT VERSION()", String.class)).append(".\n")
            .append("Observed classification-filter business SELECT statements: public=2; administrator=2. Authenticated HTTP adds one credential-version SELECT.\n")
            .append("Both business reads use a single UTC microsecond time and a read-only REPEATABLE_READ snapshot.\n")
            .append("Bound category: CULTURE. Other parameter values are omitted.\n")
            .append("Actual plans describe this owned fixture; query counts do not establish production throughput or latency improvement. No category index was added.\n");
        for (var query : java.util.stream.Stream.concat(publicQueries.stream(), adminQueries.subList(1, 3).stream()).toList()) {
            assertThat(query.sql()).contains("a.category = ?");
            assertThat(query.parameters().stream().filter("CULTURE"::equals).count()).isEqualTo(1);
            var plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.parameters().toArray());
            assertThat(plan).isNotEmpty();
            assertThat(plan).anyMatch(row -> "a".equals(row.get("table")));
            evidence.append("\n## ").append(query.id()).append("\n\n```sql\n").append(query.sql()).append("\n```\n\n")
                .append("Actual EXPLAIN rows (parameter values omitted except the category above):\n").append(plan).append("\n");
        }
        Path directory = Path.of("..", ".runtime"); Files.createDirectories(directory);
        Files.writeString(directory.resolve("category-query-evidence.md"), evidence.toString(), StandardCharsets.UTF_8);
        for (boolean paged : List.of(false, true)) {
            String path = "/api/me/registrations" + (paged ? "/search" : "");
            var queries = captureHttp(() -> mvc.perform(get(path).with(user(memberPrincipal))).andExpect(status().isOk())
                .andExpect(jsonPath(paged ? "$.items[0].activity.category" : "$[0].activity.category").value("CULTURE")));
            assertThat(queries).hasSize(paged ? 3 : 2); assertThat(queries.getFirst().id()).isEqualTo(VERSION);
            assertThat(queries.subList(1, queries.size())).allSatisfy(query -> assertThat(query.id()).startsWith(RegistrationMapper.class.getName() + "."));
            assertThat(queries).noneMatch(query -> query.id().equals(ActivityMapper.class.getName() + ".findById"));
            assertSnapshot(queries.subList(1, queries.size()));
        }
    }

    private static void assertSnapshot(List<Query> queries) { queries.forEach(query -> {
        assertThat(query.readOnly()).isTrue();
        // Legacy array retains its pre-existing default isolation; paged queries are explicitly RR.
        if (!query.id().endsWith(".findMine")) assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }); }
    private List<Query> capture(Runnable action) { List<Query> queries = new ArrayList<>(); reads.captured.set(queries);
        try { action.run(); return List.copyOf(queries); } finally { reads.captured.remove(); } }
    interface HttpCheck { void run() throws Exception; }
    private List<Query> captureHttp(HttpCheck action) { return capture(() -> { try { action.run(); } catch (Exception failure) { throw new IllegalStateException("HTTP category verification failed", failure); } }); }
    private long create(String category, int capacity) { String title = prefix + " " + UUID.randomUUID();
        long id = activities.create(new CreateActivityRequest(title, DESCRIPTION, "会场", NOW.plusSeconds(3600), capacity, category), adminId()).id();
        activityFixtures.put(id, title); return id; }
    private long createUser() { String name = "category_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(name, users.findByUsername("demo").passwordHash(), "分类验证用户", "USER");
        long id = users.findByUsername(name).id(); userFixtures.put(id, name); return id; }
    private EditActivityRequest edit(long id, String category) { return new EditActivityRequest(activityFixtures.get(id), DESCRIPTION, "会场", category); }
    private Map<String, Object> createBody(String title, String category) { Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title); body.put("description", DESCRIPTION); body.put("location", "会场");
        body.put("startsAt", NOW.plusSeconds(3600).toString()); body.put("capacity", 2); body.put("category", category); return body; }
    private Map<String, Object> editBody(long id, String category) { Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", activityFixtures.get(id)); body.put("description", DESCRIPTION); body.put("location", "会场"); body.put("category", category); return body; }
    private Map<String, Object> state(long id) { return Map.of("activity", jdbc.queryForMap("SELECT * FROM activities WHERE id=?", id),
        "registrations", jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", id),
        "notifications", jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", id),
        "audit", jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", id)); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocalDateTime utc(Instant value) { return LocalDateTime.ofInstant(value.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC); }
    private static void inOtherThread(Runnable action) { try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(15, TimeUnit.SECONDS); }
        catch (Exception failure) { throw new IllegalStateException("Category fixture change failed to commit", failure); } }
}

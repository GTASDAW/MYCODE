package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.api.MyRegistrationModels.*;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.mapper.CredentialVersionMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.monitoring.MonitoringService;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.CheckInService;
import com.example.gather.service.RegistrationService;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Owned fixtures and real InnoDB snapshots, with statement counts and actual EXPLAIN evidence. */
@SpringBootTest
@AutoConfigureMockMvc
@Import(MyRegistrationSearchIntegrationTest.Configuration.class)
@ExtendWith(OutputCaptureExtension.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class MyRegistrationSearchIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-09-01T09:00:00.123456789Z");
    private static final String PATH = "/api/me/registrations/search";

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary CountingClock myRegistrationClock() { return new CountingClock(); }
        @Bean MyReadInterceptor myReadInterceptor() { return new MyReadInterceptor(); }
    }

    static class CountingClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return NOW; }
    }

    record Query(String statement, String sql, List<Object> parameters, boolean readOnly, Integer isolation) {}
    @Intercepts(@Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))
    static class MyReadInterceptor implements Interceptor {
        final AtomicReference<Runnable> afterTotals = new AtomicReference<>();
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            var records = captured.get();
            if (records != null) {
                var bound = statement.getBoundSql(invocation.getArgs()[1]);
                var values = new ArrayList<Object>();
                var parameter = statement.getConfiguration().newMetaObject(invocation.getArgs()[1]);
                for (var mapping : bound.getParameterMappings()) {
                    values.add(bound.hasAdditionalParameter(mapping.getProperty())
                        ? bound.getAdditionalParameter(mapping.getProperty()) : parameter.getValue(mapping.getProperty()));
                }
                records.add(new Query(statement.getId(), bound.getSql(), values,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                    TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            Object result = invocation.proceed();
            if (statement.getId().equals(RegistrationMapper.class.getName() + ".mineTotals")) {
                Runnable action = afterTotals.getAndSet(null);
                if (action != null) action.run();
            }
            return result;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !java.net.URI.create(url.substring("jdbc:".length())).getPath().equals("/activity_platform_test")) {
            throw new IllegalStateException("My registration tests require the dedicated REAL activity_platform_test MySQL database");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }
    private static String environment(String key, String fallback) {
        String value = System.getenv(key); return value == null ? fallback : value;
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired CheckInService checkIns;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MonitoringService monitoring;
    @Autowired CountingClock clock;
    @Autowired MyReadInterceptor reads;
    @Autowired ObjectMapper json;
    private final Map<Long, String> activityFixtures = new LinkedHashMap<>();
    private final Map<Long, String> userFixtures = new LinkedHashMap<>();

    @BeforeEach
    void verifyDedicatedCurrentSchemaBeforeFixtureWrites() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT version FROM flyway_schema_history WHERE success=1 ORDER BY installed_rank DESC LIMIT 1", String.class))
            .isEqualTo("11");
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at FROM activities LIMIT 0");
        jdbc.queryForList("SELECT id, activity_id, actor_user_id, registration_id, changes_json FROM activity_audit_logs LIMIT 0");
    }

    @AfterEach
    void cleanExactlyOwnedRowsAndProtectExternalAccountReferences() {
        reads.afterTotals.set(null);
        reads.captured.remove();
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            activityFixtures.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
            userFixtures.forEach((id, name) -> assertThat(jdbc.queryForObject("SELECT username FROM users WHERE id=?", String.class, id)).isEqualTo(name));
            for (long id : userFixtures.keySet()) {
                for (String query : List.of("SELECT activity_id FROM registrations WHERE user_id=?",
                    "SELECT activity_id FROM registrations WHERE checked_in_by=?", "SELECT activity_id FROM notifications WHERE user_id=?",
                    "SELECT id FROM activities WHERE created_by=?", "SELECT id FROM activities WHERE cancelled_by=?")) {
                    assertThat(jdbc.queryForList(query, Long.class, id)).allMatch(activityFixtures::containsKey);
                }
            }
            com.example.gather.support.OwnedIntegrationFixtures.remove(jdbc, activityFixtures.keySet(), userFixtures.keySet());
        });
    }

    @Test
    void bothReadContractsRequireAuthenticationAndUseTrustedUserForUserAndAdmin() throws Exception {
        for (String path : List.of(PATH, "/api/me/registrations")) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        }
        long user = createUser("USER", "本人");
        long admin = createUser("ADMIN", "管理员本人");
        long userActivity = createActivity(2);
        long adminActivity = createActivity(2);
        long userRegistration = register(userActivity, user);
        long adminRegistration = register(adminActivity, admin);
        for (long owner : List.of(user, admin)) {
            long other = owner == user ? admin : user;
            long expected = owner == user ? userRegistration : adminRegistration;
            mvc.perform(get(PATH).with(user(principal(owner))).param("userId", Long.toString(other)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].id").value(expected)).andExpect(jsonPath("$.page").value(1))
                .andExpect(jsonPath("$.pageSize").value(10)).andExpect(jsonPath("$.summary.activeRegistrations").value(1));
            mvc.perform(get("/api/me/registrations").with(user(principal(owner))).param("userId", Long.toString(other)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1)).andExpect(jsonPath("$[0].id").value(expected));
        }
    }

    @Test
    void legacyArrayRetainsExactFieldsAndFullActivityProjectionWithoutAttendanceActor() throws Exception {
        long owner = createUser("USER", "完整活动");
        long waiting = createUser("USER", "候补");
        long activity = createActivity(1);
        long registration = register(activity, owner);
        register(activity, waiting);
        var old = mvc.perform(get("/api/me/registrations").with(user(principal(owner))))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].activity.waitingCount").value(1))
            .andExpect(jsonPath("$[0].activity.registrationStatus").value("ACTIVE")).andReturn().getResponse().getContentAsString();
        var item = json.readTree(old).get(0);
        assertThat(item.size()).isEqualTo(3);
        assertThat(item.has("id") && item.has("status") && item.has("activity")).isTrue();
        assertThat(item.get("id").asLong()).isEqualTo(registration);
        assertThat(item.get("activity").get("id").asLong()).isEqualTo(activity);
        assertThat(item.get("activity").get("category").asString()).isEqualTo("UNCATEGORIZED");
        assertThat(registrations.mine(owner).getFirst().activity()).isEqualTo(activities.get(activity, owner));
        activities.cancel(activity, new CancelActivityRequest("历史取消原因"), adminId());
        var cancelled = registrations.mine(owner).getFirst();
        assertThat(cancelled.id()).isEqualTo(registration);
        assertThat(cancelled.status()).isEqualTo("CANCELLED");
        assertThat(cancelled.activity()).isEqualTo(activities.get(activity, owner));
        assertThat(cancelled.activity().cancellationReason()).isEqualTo("历史取消原因");
        assertThat(cancelled.activity().registeredCount()).isZero();
        assertThat(cancelled.activity().waitingCount()).isZero();
        assertThat(cancelled.activity().closed() && cancelled.activity().cancelled()).isTrue();
        assertThat(old).doesNotContain("checkedInAt", "checkedInBy", "displayName");
    }

    @Test
    void paginationUsesUpdatedThenRegistrationIdDescendingWithoutRepeatsAndPreservesLegacyOrder() throws Exception {
        long owner = createUser("USER", "稳定分页");
        var expected = new ArrayList<Long>();
        for (int i = 0; i < 13; i++) {
            long registration = register(createActivity(2), owner);
            jdbc.update("UPDATE registrations SET updated_at=? WHERE id=?", utc(NOW.minusSeconds(i / 4)), registration);
            expected.add(registration);
        }
        expected.sort(Comparator.<Long, LocalDateTime>comparing(id -> jdbc.queryForObject("SELECT updated_at FROM registrations WHERE id=?", LocalDateTime.class, id))
            .reversed().thenComparing(Comparator.reverseOrder()));
        var seen = new ArrayList<Long>();
        for (int page = 1; page <= 3; page++) {
            var result = registrations.searchMine(owner, page, 5, "ALL");
            assertThat(result.total()).isEqualTo(13);
            assertThat(result.page()).isEqualTo(page);
            assertThat(result.pageSize()).isEqualTo(5);
            assertThat(result.summary()).isEqualTo(new MyRegistrationSummary(13, 0, 0, 0));
            seen.addAll(result.items().stream().map(MyRegistrationView::id).toList());
        }
        assertThat(seen).containsExactlyElementsOf(expected).doesNotHaveDuplicates();
        assertThat(registrations.mine(owner)).extracting(RegistrationView::id).containsExactlyElementsOf(expected);
        mvc.perform(get(PATH).with(user(principal(owner))).param("page", "3").param("pageSize", "5"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(3))
            .andExpect(jsonPath("$.total").value(13)).andExpect(jsonPath("$.items[0].id").value(expected.get(10)));
    }

    @Test
    void allFiltersKeepFullSummaryAndExposeOnlyOwnUtcAttendanceTime() throws Exception {
        long owner = createUser("USER", "状态筛选");
        String secret = "PRIVATE_CHECKER_" + UUID.randomUUID();
        long checker = createUser("ADMIN", secret);
        long filler = createUser("USER", "占位");
        var ids = new LinkedHashMap<String, List<Long>>();
        ids.put("ACTIVE", new ArrayList<>()); ids.put("WAITING", new ArrayList<>()); ids.put("CANCELLED", new ArrayList<>());
        for (int i = 0; i < 4; i++) {
            long activity = createActivity(2);
            long registration = register(activity, owner);
            ids.get("ACTIVE").add(registration);
            if (i < 2) { start(activity, NOW.minusSeconds(1)); checkIns.checkIn(activity, registration, checker); }
        }
        for (int i = 0; i < 3; i++) {
            long activity = createActivity(1); register(activity, filler);
            ids.get("WAITING").add(register(activity, owner));
        }
        for (int i = 0; i < 2; i++) {
            long activity = createActivity(2);
            ids.get("CANCELLED").add(register(activity, owner)); registrations.cancel(activity, owner);
        }
        for (String filter : List.of("ALL", "ACTIVE", "WAITING", "CANCELLED")) {
            var page = registrations.searchMine(owner, 1, 2, filter);
            assertThat(page.total()).isEqualTo(filter.equals("ALL") ? 9 : ids.get(filter).size());
            assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(4, 3, 2, 2));
            if (!filter.equals("ALL")) assertThat(page.items()).allMatch(item -> item.status().equals(filter));
            assertThat(page.items()).allMatch(item -> item.status().equals(item.activity().registrationStatus()));
        }
        var all = registrations.searchMine(owner, 1, 100, "ALL");
        assertThat(all.items()).filteredOn(item -> item.checkedInAt() != null).hasSize(2)
            .allMatch(item -> item.checkedInAt().equals(NOW.truncatedTo(ChronoUnit.MICROS)) && item.status().equals("ACTIVE"));
        var response = mvc.perform(get(PATH).with(user(principal(owner))).param("pageSize", "100"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.summary.checkedInRegistrations").value(2)).andReturn().getResponse().getContentAsString();
        var tree = json.readTree(response);
        for (var item : tree.get("items")) {
            assertThat(item.size()).isEqualTo(4);
            assertThat(item.has("id") && item.has("status") && item.has("activity") && item.has("checkedInAt")).isTrue();
        }
        assertThat(response).doesNotContain("checkedInBy", "checked_in_by", secret);
    }

    @Test
    void emptyAndBeyondEndPagesRetainRequestedPageAndTrueTotals() throws Exception {
        long owner = createUser("USER", "空集合");
        var empty = registrations.searchMine(owner, Integer.MAX_VALUE, 100, "ALL");
        assertThat(empty.items()).isEmpty(); assertThat(empty.total()).isZero();
        assertThat(empty.summary()).isEqualTo(new MyRegistrationSummary(0, 0, 0, 0));
        register(createActivity(2), owner);
        for (int page : List.of(2, Integer.MAX_VALUE)) {
            mvc.perform(get(PATH).with(user(principal(owner))).param("page", Integer.toString(page)).param("pageSize", "100"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty()).andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.page").value(page)).andExpect(jsonPath("$.pageSize").value(100))
                .andExpect(jsonPath("$.summary.activeRegistrations").value(1));
        }
        var waiting = registrations.searchMine(owner, 1, 10, "WAITING");
        assertThat(waiting.total()).isZero(); assertThat(waiting.items()).isEmpty();
        assertThat(waiting.summary().activeRegistrations()).isEqualTo(1);
    }

    @Test
    void explicitBlankMalformedAndOutOfRangeParametersAreValidationErrors() throws Exception {
        var owner = principal(createUser("USER", "参数"));
        for (String[] pair : List.of(new String[]{"page", ""}, new String[]{"page", "0"}, new String[]{"page", "-1"},
            new String[]{"page", "+1"}, new String[]{"page", " 1"}, new String[]{"page", "1.0"}, new String[]{"page", "2147483648"},
            new String[]{"page", "x"}, new String[]{"pageSize", ""}, new String[]{"pageSize", "0"}, new String[]{"pageSize", "101"},
            new String[]{"pageSize", "-1"}, new String[]{"pageSize", "1.5"}, new String[]{"status", ""}, new String[]{"status", "active"},
            new String[]{"status", "OPEN"}, new String[]{"status", "UNKNOWN"})) {
            mvc.perform(get(PATH).with(user(owner)).param(pair[0], pair[1]))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        mvc.perform(get(PATH).with(user(owner)).param("pageSize", "100")).andExpect(status().isOk());
    }

    @Test
    void oneMicrosecondClockReadCoversEveryItemForBothReadContracts() {
        long owner = createUser("USER", "时钟边界");
        long boundary = createActivity(2); register(boundary, owner); start(boundary, NOW.truncatedTo(ChronoUnit.MICROS));
        long next = createActivity(2); register(next, owner); start(next, NOW.truncatedTo(ChronoUnit.MICROS).plus(1, ChronoUnit.MICROS));
        clock.calls.set(0);
        var page = registrations.searchMine(owner, 1, 10, "ALL");
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(page.items()).filteredOn(item -> item.activity().id() == boundary).allMatch(item -> item.activity().closed());
        assertThat(page.items()).filteredOn(item -> item.activity().id() == next).noneMatch(item -> item.activity().closed());
        clock.calls.set(0);
        var old = registrations.mine(owner);
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(old).extracting(RegistrationView::activity).containsExactlyElementsOf(page.items().stream().map(MyRegistrationView::activity).toList());
    }

    @Test
    void cancellationCommittedBetweenTotalsAndPageRemainsInOneReadSnapshot() {
        long owner = createUser("USER", "取消快照");
        long activity = createActivity(2); register(activity, owner);
        reads.afterTotals.set(() -> inOtherThread(() -> activities.cancel(activity, new CancelActivityRequest("并发取消"), adminId())));
        var page = registrations.searchMine(owner, 1, 10, "ACTIVE");
        assertThat(reads.afterTotals.get()).isNull();
        assertThat(page.total()).isEqualTo(1);
        assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(1, 0, 0, 0));
        assertThat(page.items()).hasSize(1).allSatisfy(item -> {
            assertThat(item.status()).isEqualTo("ACTIVE");
            assertThat(item.activity().cancelled()).isFalse();
            assertThat(item.activity().registeredCount()).isEqualTo(1);
        });
        var next = registrations.searchMine(owner, 1, 10, "ACTIVE");
        assertThat(next.total()).isZero(); assertThat(next.items()).isEmpty();
        assertThat(next.summary()).isEqualTo(new MyRegistrationSummary(0, 0, 1, 0));
        assertThat(registrations.searchMine(owner, 1, 10, "CANCELLED").items()).hasSize(1)
            .allMatch(item -> item.activity().cancelled() && item.activity().registeredCount() == 0);
    }

    @Test
    void checkInCommittedBetweenTotalsAndPageIsVisibleOnlyToNextRead() {
        long owner = createUser("USER", "签到快照");
        long activity = createActivity(2); long registration = register(activity, owner); start(activity, NOW.minusSeconds(1));
        reads.afterTotals.set(() -> inOtherThread(() -> checkIns.checkIn(activity, registration, adminId())));
        var page = registrations.searchMine(owner, 1, 10, "ACTIVE");
        assertThat(reads.afterTotals.get()).isNull();
        assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(1, 0, 0, 0));
        assertThat(page.items()).hasSize(1).allMatch(item -> item.checkedInAt() == null && item.activity().closed());
        var next = registrations.searchMine(owner, 1, 10, "ALL");
        assertThat(next.summary()).isEqualTo(new MyRegistrationSummary(1, 0, 0, 1));
        assertThat(next.items()).hasSize(1).allMatch(item -> item.checkedInAt().equals(NOW.truncatedTo(ChronoUnit.MICROS)));
    }

    @Test
    void legacyUsesOneAndPagedUsesTwoDataSelectsInReadOnlyRepeatableReadWithoutAnyWrites() {
        long owner = createUser("USER", "查询次数");
        long activity = createActivity(2); register(activity, owner); register(activity, createUser("USER", "同行"));
        var before = fixtureState(activity);
        var old = capture(() -> registrations.mine(owner));
        assertThat(old).extracting(Query::statement).containsExactly(RegistrationMapper.class.getName() + ".findMine");
        var paged = capture(() -> registrations.searchMine(owner, 1, 10, "ALL"));
        assertThat(paged).extracting(Query::statement).containsExactly(RegistrationMapper.class.getName() + ".mineTotals", RegistrationMapper.class.getName() + ".searchMine");
        for (var query : java.util.stream.Stream.concat(old.stream(), paged.stream()).toList()) {
            assertThat(query.sql()).startsWith("SELECT").doesNotContain("FOR UPDATE", "checked_in_by");
            assertThat(query.statement()).doesNotContain("ActivityMapper", "findById");
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        }
        assertThat(fixtureState(activity)).isEqualTo(before);
    }

    @Test
    void authenticatedHttpAddsOneCredentialReadWithoutChangingLegacyOrPagedBusinessQueryCounts() {
        long owner = createUser("USER", "认证与业务查询分列");
        register(createActivity(2), owner);
        var identity = principal(owner);
        var old = capture(() -> {
            try { mvc.perform(get("/api/me/registrations").with(user(identity))).andExpect(status().isOk()); }
            catch (Exception failure) { throw new IllegalStateException("Authenticated legacy read failed", failure); }
        });
        assertThat(old).extracting(Query::statement).containsExactly(
            CredentialVersionMapper.class.getName() + ".findByUserId", RegistrationMapper.class.getName() + ".findMine");
        var paged = capture(() -> {
            try { mvc.perform(get(PATH).with(user(identity))).andExpect(status().isOk()); }
            catch (Exception failure) { throw new IllegalStateException("Authenticated paged read failed", failure); }
        });
        assertThat(paged).extracting(Query::statement).containsExactly(
            CredentialVersionMapper.class.getName() + ".findByUserId", RegistrationMapper.class.getName() + ".mineTotals",
            RegistrationMapper.class.getName() + ".searchMine");
        for (var credential : List.of(old.getFirst(), paged.getFirst())) {
            assertThat(credential.sql()).contains("SELECT credential_version").doesNotContain("password_hash", "FOR UPDATE");
            assertThat(credential.parameters()).containsExactly(owner);
        }
        assertThat(paged.subList(1, paged.size())).allSatisfy(query -> {
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        });
    }

    @Test
    void actualMySqlExplainUsesTheCapturedJoinedStatementsAndWritesBoundedEvidence() throws Exception {
        long owner = createUser("USER", "执行计划");
        for (int i = 0; i < 13; i++) register(createActivity(2), owner);
        var old = capture(() -> registrations.mine(owner));
        var paged = capture(() -> registrations.searchMine(owner, 2, 10, "ACTIVE"));
        var evidence = new StringBuilder("# My registration query evidence\n\n")
            .append("Dedicated database: activity_platform_test; MySQL ").append(jdbc.queryForObject("SELECT VERSION()", String.class)).append(".\n")
            .append("Owned fixture: 13 activities and 13 personal registration rows.\n")
            .append("Observed service business SELECT statements: legacy=1; paged=2. Authenticated HTTP adds one credential-version SELECT.\n")
            .append("These are statement counts, not a constant-work or production latency claim. Waiting counts use a correlated subquery.\n");
        for (var query : java.util.stream.Stream.concat(old.stream(), paged.stream()).toList()) {
            var plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.parameters().toArray());
            assertThat(plan).isNotEmpty();
            assertThat(plan).anyMatch(row -> "r".equals(row.get("table")));
            if (!query.statement().endsWith(".mineTotals")) {
                assertThat(plan).anyMatch(row -> "a".equals(row.get("table")));
                assertThat(plan).anyMatch(row -> "rw".equals(row.get("table")));
            }
            evidence.append("\n## ").append(query.statement().substring(query.statement().lastIndexOf('.') + 1)).append("\n\n")
                .append("```sql\n").append(query.sql()).append("\n```\n\n")
                .append("Actual EXPLAIN rows (no parameter values):\n").append(plan).append("\n");
        }
        Path directory = Path.of("..", ".runtime"); Files.createDirectories(directory);
        Files.writeString(directory.resolve("myregistrations-query-evidence.md"), evidence.toString(), StandardCharsets.UTF_8);
    }

    @Test
    void searchRouteUsesFiniteMetricAndLogLabelEvenBeforeAuthentication(CapturedOutput output) throws Exception {
        var principal = principal(createUser("USER", "请求日志"));
        long before = monitoring.snapshot().routes().stream().filter(route -> route.route().equals(PATH)).mapToLong(route -> route.count()).sum();
        String secret = "PRIVATE_MY_REGISTRATION_QUERY_" + UUID.randomUUID();
        for (boolean authenticated : List.of(false, true)) {
            var request = get(PATH).param("private", secret);
            if (authenticated) request.with(user(principal));
            var response = mvc.perform(request).andExpect(status().is(authenticated ? 200 : 401)).andReturn().getResponse();
            String id = response.getHeader("X-Request-Id");
            assertThat(UUID.fromString(id).toString()).isEqualTo(id);
            String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(id) && value.contains("http_request"))
                .findFirst().orElseThrow();
            assertThat(json.readTree(line).get("route").asString()).isEqualTo(PATH);
            assertThat(line).doesNotContain(secret);
        }
        assertThat(monitoring.snapshot().routes().stream().filter(route -> route.route().equals(PATH)).mapToLong(route -> route.count()).sum()).isEqualTo(before + 2);
    }

    private List<Query> capture(Runnable read) {
        var queries = new ArrayList<Query>(); reads.captured.set(queries);
        try { read.run(); return List.copyOf(queries); }
        finally { reads.captured.remove(); }
    }
    private Map<String, Object> fixtureState(long activity) {
        return Map.of("activity", jdbc.queryForMap("SELECT * FROM activities WHERE id=?", activity),
            "registrations", jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", activity),
            "notifications", jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", activity),
            "audit", jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", activity));
    }
    private long createActivity(int capacity) {
        String title = "MyRegistration " + UUID.randomUUID();
        long id = activities.create(new CreateActivityRequest(title, "个人报名查询验证", "本地测试", NOW.plusSeconds(3600), capacity), adminId()).id();
        activityFixtures.put(id, title); return id;
    }
    private long createUser(String role, String name) {
        String username = "myreg_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), name, role);
        long id = users.findByUsername(username).id(); userFixtures.put(id, username); return id;
    }
    private long register(long activity, long member) {
        registrations.register(activity, member);
        return jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activity, member);
    }
    private void start(long activity, Instant time) { jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(time), activity); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time, ZoneOffset.UTC); }
    private static void inOtherThread(Runnable action) {
        try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(20, TimeUnit.SECONDS); }
        catch (Exception exception) { throw new IllegalStateException("Concurrent fixture writer must commit before the page SELECT", exception); }
    }
}

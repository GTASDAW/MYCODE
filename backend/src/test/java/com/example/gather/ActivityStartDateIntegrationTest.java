package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.RegistrationService;
import com.example.gather.support.OwnedIntegrationFixtures;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL date boundaries, shared filtering, query count and snapshot contract. */
@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ActivityStartDateIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ActivityStartDateIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-01-10T09:00:00.123456789Z");
    private static final Instant MICRO_NOW = NOW.truncatedTo(ChronoUnit.MICROS);
    private static final String PUBLIC = "/api/activities/search";
    private static final String ADMIN = "/api/admin/activities";
    private static final String VERSION = "com.example.gather.mapper.CredentialVersionMapper.findByUserId";
    private static final Instant LEAP_START = Instant.parse("2036-02-28T16:00:00Z");
    private static final Instant LEAP_UNTIL = Instant.parse("2036-02-29T16:00:00Z");

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary DateClock dateClock() { return new DateClock(); }
        @Bean DateReads dateReads() { return new DateReads(); }
    }

    static class DateClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return NOW; }
    }

    record Read(String id, String sql, LocalDateTime now, LocalDateTime from, LocalDateTime until,
                boolean readOnly, Integer isolation) {}
    record Hook(String id, Runnable after) {}

    @Intercepts(@Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))
    static class DateReads implements Interceptor {
        final ThreadLocal<List<Read>> captured = new ThreadLocal<>();
        final AtomicReference<Hook> hook = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            Object input = invocation.getArgs()[1];
            if (captured.get() != null) {
                Map<?, ?> parameters = input instanceof Map<?, ?> map ? map : Map.of();
                // Authentication has a separate scalar input and is recorded independently of business queries.
                boolean business = statement.getId().startsWith(ActivityMapper.class.getName() + ".")
                    || statement.getId().startsWith(AdminMapper.class.getName() + ".");
                captured.get().add(new Read(statement.getId(), statement.getBoundSql(input).getSql(),
                    business ? (LocalDateTime) parameters.get("now") : null,
                    business ? (LocalDateTime) parameters.get("startFromUtc") : null,
                    business ? (LocalDateTime) parameters.get("startUntilUtc") : null,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                    TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            Object result = invocation.proceed();
            Hook next = hook.get();
            if (next != null && next.id().equals(statement.getId()) && hook.compareAndSet(next, null)) next.after().run();
            return result;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath())) {
            throw new IllegalStateException("Activity start-date tests require dedicated REAL activity_platform_test MySQL");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }

    private static String environment(String key, String fallback) {
        return System.getenv(key) == null ? fallback : System.getenv(key);
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityMapper mapper;
    @Autowired ActivityService activities;
    @Autowired AdminService admin;
    @Autowired RegistrationService registrations;
    @Autowired DateClock clock;
    @Autowired DateReads reads;
    private final Map<Long, String> activityFixtures = new LinkedHashMap<>();
    private final Map<Long, String> userFixtures = new LinkedHashMap<>();
    private final String prefix = "StartDate " + UUID.randomUUID();

    @BeforeEach
    void verifyDedicatedCurrentSchemaBeforeWrites() {
        com.example.gather.support.OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(15);
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at, registration_deadline FROM activities LIMIT 0");
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
    }

    @AfterEach
    void cleanOnlyOwnedFixtures() {
        reads.captured.remove();
        reads.hook.set(null);
        activityFixtures.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        userFixtures.forEach((id, name) -> assertThat(users.findById(id).username()).isEqualTo(name));
        OwnedIntegrationFixtures.remove(jdbc, activityFixtures.keySet(), userFixtures.keySet());
    }

    @Test
    void bothEndpointsUseInclusiveBeijingDatesAndExactUtcMicrosecondBoundariesAndAllowEachSingleSide() throws Exception {
        long before = create(LEAP_START.minus(1, ChronoUnit.MICROS));
        long first = create(LEAP_START);
        long tie = create(LEAP_START);
        long last = create(LEAP_UNTIL.minus(1, ChronoUnit.MICROS));
        long next = create(LEAP_UNTIL);
        for (String path : List.of(PUBLIC, ADMIN)) {
            assertIds(response(request(path).param("startDateFrom", "2036-02-29").param("startDateTo", "2036-02-29")), first, tie, last);
            assertIds(response(request(path).param("startDateFrom", "2036-02-29")), first, tie, last, next);
            assertIds(response(request(path).param("startDateTo", "2036-02-29")), before, first, tie, last);
            var empty = response(request(path).param("startDateFrom", "2036-03-02").param("startDateTo", "2036-03-02"));
            assertIds(empty);
            assertThat(empty.get("total").asLong()).isZero();
            if (path.equals(PUBLIC)) {
                assertThat(empty.get("summary").get("upcomingActivities").asLong()).isZero();
                assertThat(empty.get("summary").get("availableSeats").asLong()).isZero();
            }
        }
        for (String name : List.of("guest", "demo", "admin")) {
            var request = request(PUBLIC).param("startDateFrom", "2036-02-29").param("startDateTo", "2036-02-29");
            if (!name.equals("guest")) request.with(user(principal(name)));
            var result = response(request);
            assertIds(result, first, tie, last);
            assertThat(Instant.parse(result.get("items").get(0).get("startsAt").asString())).isEqualTo(LEAP_START);
            assertThat(result.get("summary").get("upcomingActivities").asLong()).isEqualTo(3);
            assertThat(result.get("summary").get("availableSeats").asLong()).isEqualTo(6);
        }
        mvc.perform(get(ADMIN).param("startDateFrom", "2036-02-29")).andExpect(status().isUnauthorized());
        mvc.perform(get(ADMIN).with(user(principal("demo"))).param("startDateFrom", "2036-02-29")).andExpect(status().isForbidden());
    }

    @Test
    void strictDatesRejectBlankMalformedImpossibleOutOfBoundsAndReverseRangesWithoutAnySpanLimit() throws Exception {
        for (String path : List.of(PUBLIC, ADMIN)) {
            for (String parameter : List.of("startDateFrom", "startDateTo")) {
                for (String value : List.of("", " ", "\t", "2036-2-29", "2036-02-9", "2036/02/29", "2035-02-29",
                    "2036-02-30", "2036-00-01", "2036-13-01", "2036-01-00", "2036-02-29 ", " 2036-02-29",
                    "2036-02-29T00:00:00", "2036-02-29Z", "+2036-02-29", "1999-12-31", "2101-01-01")) {
                    mvc.perform(request(path).param(parameter, value)).andExpect(status().isBadRequest())
                        .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
                }
            }
            mvc.perform(request(path).param("startDateFrom", "2036-03-01").param("startDateTo", "2036-02-29"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            for (String date : List.of("2000-01-01", "2000-02-29", "2036-02-29", "2100-12-31")) {
                mvc.perform(request(path).param("startDateFrom", date).param("startDateTo", date)).andExpect(status().isOk());
                mvc.perform(request(path).param("startDateFrom", date)).andExpect(status().isOk());
                mvc.perform(request(path).param("startDateTo", date)).andExpect(status().isOk());
            }
            mvc.perform(request(path).param("startDateFrom", "2000-01-01").param("startDateTo", "2100-12-31"))
                .andExpect(status().isOk());
        }
    }

    @Test
    void omittedDatesKeepOldUnboundedSemanticsOldServiceOverloadsAndArrayResponse() throws Exception {
        long old = create(Instant.parse("1999-12-31T00:00:00Z"));
        long current = create(LEAP_START);
        long future = create(Instant.parse("2101-01-01T00:00:00Z"));
        assertIds(response(request(PUBLIC)), old, current, future);
        assertIds(response(request(ADMIN)), old, current, future);
        assertThat(activities.search(1, 12, prefix, "ALL", null)).isEqualTo(activities.search(1, 12, prefix, "ALL", "ALL", null, null, null));
        assertThat(activities.search(1, 12, prefix, "ALL", "TECHNOLOGY", null)).isEqualTo(activities.search(1, 12, prefix, "ALL", "TECHNOLOGY", null, null, null));
        assertThat(admin.activities(1, 10, prefix, "ALL", adminId())).isEqualTo(admin.activities(1, 10, prefix, "ALL", "ALL", null, null, adminId()));
        assertThat(admin.activities(1, 10, prefix, "ALL", "TECHNOLOGY", adminId())).isEqualTo(admin.activities(1, 10, prefix, "ALL", "TECHNOLOGY", null, null, adminId()));
        var legacy = json.readTree(mvc.perform(get("/api/activities").param("startDateFrom", "2036-02-29"))
            .andExpect(status().isOk()).andExpect(jsonPath("$").isArray()).andReturn().getResponse().getContentAsString());
        List<Long> legacyIds = new ArrayList<>();
        legacy.forEach(item -> legacyIds.add(item.get("id").asLong()));
        assertThat(legacyIds).contains(old, current, future);
        mvc.perform(request(PUBLIC)).andExpect(jsonPath("$.page").value(1)).andExpect(jsonPath("$.pageSize").value(12));
        mvc.perform(request(ADMIN)).andExpect(jsonPath("$.page").value(1)).andExpect(jsonPath("$.pageSize").value(10));
    }

    @Test
    void datesCombineWithLiteralKeywordCategoryEveryStateAndPaginationWhileSummaryCoversAllMatches() throws Exception {
        long started = create(MICRO_NOW.minusSeconds(7200));
        long ongoing = create(MICRO_NOW.minusSeconds(3600), MICRO_NOW.plusSeconds(100), null, "TECHNOLOGY", 2, prefix);
        long ended = create(MICRO_NOW.minusSeconds(1800), MICRO_NOW.minus(1, ChronoUnit.MICROS), null, "TECHNOLOGY", 2, prefix);
        long open = create(MICRO_NOW.plusSeconds(1000), null, null, "TECHNOLOGY", 4, prefix);
        registrations.register(open, createUser());
        long full = create(MICRO_NOW.plusSeconds(2000), null, null, "TECHNOLOGY", 1, prefix);
        registrations.register(full, createUser());
        long deadlineClosed = create(MICRO_NOW.plusSeconds(3000), null, MICRO_NOW.minusSeconds(1), "TECHNOLOGY", 5, prefix);
        long cancelled = create(MICRO_NOW.plusSeconds(4000));
        activities.cancel(cancelled, new CancelActivityRequest("Owned date fixture cancellation"), adminId());
        create(MICRO_NOW.plusSeconds(5000), null, null, "SPORTS", 7, prefix);
        create(MICRO_NOW.plusSeconds(6000), null, null, "TECHNOLOGY", 8, "Unmatched " + UUID.randomUUID());
        create(LEAP_START);
        Map<String, List<Long>> states = new LinkedHashMap<>();
        states.put("ALL", List.of(started, ongoing, ended, open, full, deadlineClosed, cancelled));
        states.put("OPEN", List.of(open)); states.put("FULL", List.of(full));
        states.put("STARTED", List.of(started, ongoing, ended)); states.put("ONGOING", List.of(ongoing));
        states.put("ENDED", List.of(ended)); states.put("UPCOMING", List.of(open, full, deadlineClosed));
        states.put("CANCELLED", List.of(cancelled));
        for (var state : states.entrySet()) {
            for (String path : List.of(PUBLIC, ADMIN)) {
                var result = response(request(path).param("category", "TECHNOLOGY").param("status", state.getKey())
                    .param("startDateFrom", "2035-01-10").param("startDateTo", "2035-01-10").param("pageSize", "2"));
                assertThat(result.get("total").asLong()).isEqualTo(state.getValue().size());
                assertIds(result, state.getValue().stream().limit(2).toArray(Long[]::new));
                if (path.equals(PUBLIC)) {
                    boolean includesOpen = state.getValue().contains(open);
                    boolean includesFull = state.getValue().contains(full);
                    assertThat(result.get("summary").get("upcomingActivities").asLong()).isEqualTo((includesOpen ? 1 : 0) + (includesFull ? 1 : 0));
                    assertThat(result.get("summary").get("availableSeats").asLong()).isEqualTo(includesOpen ? 3 : 0);
                }
            }
        }
        for (String path : List.of(PUBLIC, ADMIN)) {
            var third = response(request(path).param("category", "TECHNOLOGY").param("page", "3").param("pageSize", "2")
                .param("startDateFrom", "2035-01-10").param("startDateTo", "2035-01-10"));
            assertIds(third, full, deadlineClosed);
            assertThat(third.get("total").asLong()).isEqualTo(7);
            var empty = response(request(path).param("category", "TECHNOLOGY").param("page", "5").param("pageSize", "2")
                .param("startDateFrom", "2035-01-10").param("startDateTo", "2035-01-10"));
            assertIds(empty);
            assertThat(empty.get("total").asLong()).isEqualTo(7);
            if (path.equals(PUBLIC)) {
                assertThat(third.get("summary")).isEqualTo(empty.get("summary"));
                assertThat(empty.get("summary").get("upcomingActivities").asLong()).isEqualTo(2);
                assertThat(empty.get("summary").get("availableSeats").asLong()).isEqualTo(3);
            }
        }
        String literal = prefix + " %_\\'";
        long literalMatch = create(LEAP_START, null, null, "CULTURE", 2, literal);
        for (String path : List.of(PUBLIC, ADMIN)) {
            assertIds(response(request(path, literal).param("category", "CULTURE")
                .param("startDateFrom", "2036-02-29").param("startDateTo", "2036-02-29")), literalMatch);
        }
    }

    @Test
    void dateQueriesKeepTwoBusinessSelectsOneMicrosecondClockAndOneReadOnlySnapshotWithBareTimestampComparisons() throws Exception {
        create(LEAP_START);
        var adminPrincipal = principal("admin");
        var memberPrincipal = principal("demo");
        clock.calls.set(0);
        var publicReads = capture(() -> activities.search(1, 12, prefix, "ALL", "TECHNOLOGY", "2036-02-29", "2036-02-29", null));
        assertThat(clock.calls).hasValue(1);
        assertThat(publicReads).extracting(Read::id).containsExactly(ActivityMapper.class.getName() + ".searchTotals", ActivityMapper.class.getName() + ".search");
        assertSnapshotAndSql(publicReads);
        clock.calls.set(0);
        var memberReads = capture(() -> mvc.perform(request(PUBLIC).with(user(memberPrincipal))
            .param("startDateFrom", "2036-02-29").param("startDateTo", "2036-02-29")).andExpect(status().isOk()));
        assertThat(clock.calls).hasValue(1);
        assertThat(memberReads).extracting(Read::id).containsExactly(VERSION, ActivityMapper.class.getName() + ".searchTotals", ActivityMapper.class.getName() + ".search");
        assertSnapshotAndSql(memberReads.subList(1, 3));
        clock.calls.set(0);
        var adminReads = capture(() -> mvc.perform(get(ADMIN).param("keyword", prefix).with(user(adminPrincipal))
            .param("startDateFrom", "2036-02-29").param("startDateTo", "2036-02-29")).andExpect(status().isOk()));
        assertThat(clock.calls).hasValue(1);
        assertThat(adminReads).extracting(Read::id).containsExactly(VERSION, AdminMapper.class.getName() + ".countActivities", AdminMapper.class.getName() + ".activities");
        assertSnapshotAndSql(adminReads.subList(1, 3));
    }

    @Test
    void bothDatedReadsKeepTheirSnapshotWhenCancellationCommitsBetweenTotalAndPage() {
        long adminId = adminId();
        long first = create(MICRO_NOW.plusSeconds(3600));
        reads.hook.set(new Hook(ActivityMapper.class.getName() + ".searchTotals", () -> inOtherThread(() ->
            activities.cancel(first, new CancelActivityRequest("Concurrent owned public date cancellation"), adminId))));
        var publicSnapshot = activities.search(1, 12, prefix, "OPEN", "TECHNOLOGY", "2035-01-10", "2035-01-10", null);
        assertThat(reads.hook.get()).isNull();
        assertThat(publicSnapshot.total()).isEqualTo(1);
        assertThat(publicSnapshot.summary()).isEqualTo(new ActivitySearchSummary(1, 2));
        assertThat(publicSnapshot.items()).singleElement().satisfies(item -> {
            assertThat(item.id()).isEqualTo(first); assertThat(item.cancelled()).isFalse();
        });
        assertThat(activities.search(1, 12, prefix, "OPEN", "TECHNOLOGY", "2035-01-10", "2035-01-10", null).total()).isZero();
        long second = create(MICRO_NOW.plusSeconds(7200));
        reads.hook.set(new Hook(AdminMapper.class.getName() + ".countActivities", () -> inOtherThread(() ->
            activities.cancel(second, new CancelActivityRequest("Concurrent owned admin date cancellation"), adminId))));
        var adminSnapshot = admin.activities(1, 10, prefix, "OPEN", "TECHNOLOGY", "2035-01-10", "2035-01-10", adminId);
        assertThat(reads.hook.get()).isNull();
        assertThat(adminSnapshot.total()).isEqualTo(1);
        assertThat(adminSnapshot.items()).singleElement().satisfies(item -> {
            assertThat(item.id()).isEqualTo(second); assertThat(item.cancelled()).isFalse();
        });
        assertThat(admin.activities(1, 10, prefix, "OPEN", "TECHNOLOGY", "2035-01-10", "2035-01-10", adminId).total()).isZero();
    }

    private static void assertSnapshotAndSql(List<Read> queries) {
        assertThat(queries).hasSize(2).allSatisfy(query -> {
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            assertThat(query.now()).isEqualTo(utc(MICRO_NOW));
            assertThat(query.from()).isEqualTo(utc(LEAP_START));
            assertThat(query.until()).isEqualTo(utc(LEAP_UNTIL));
            assertThat(query.sql()).contains("a.starts_at >= ?", "a.starts_at < ?");
            assertThat(query.sql()).doesNotMatch("(?is).*\\b(?:DATE|DATE_FORMAT|CONVERT_TZ)\\s*\\(.*");
        });
    }

    private MockHttpServletRequestBuilder request(String path) {
        return request(path, prefix);
    }

    private MockHttpServletRequestBuilder request(String path, String keyword) {
        var request = get(path).param("keyword", keyword);
        return path.equals(ADMIN) ? request.with(user(principal("admin"))) : request;
    }

    private JsonNode response(MockHttpServletRequestBuilder request) throws Exception {
        return json.readTree(mvc.perform(request).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
    }

    private static void assertIds(JsonNode result, Long... expected) {
        List<Long> ids = new ArrayList<>();
        result.get("items").forEach(item -> ids.add(item.get("id").asLong()));
        assertThat(ids).containsExactly(expected);
    }

    interface CheckedAction { void run() throws Exception; }
    private List<Read> capture(CheckedAction action) throws Exception {
        List<Read> captured = new ArrayList<>();
        reads.captured.set(captured);
        try { action.run(); return List.copyOf(captured); }
        finally { reads.captured.remove(); }
    }

    private long create(Instant start) { return create(start, null, null, "TECHNOLOGY", 2, prefix); }
    private long create(Instant start, Instant end, Instant deadline, String category, int capacity, String marker) {
        String title = marker + " " + UUID.randomUUID();
        var row = new NewActivity(title, "Owned start-date integration fixture", "会场", utc(start), capacity, adminId(), category,
            end == null ? null : utc(end), deadline == null ? null : utc(deadline));
        mapper.insert(row);
        activityFixtures.put(row.id, title);
        return row.id;
    }

    private long createUser() {
        String name = "startdate_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(name, users.findByUsername("demo").passwordHash(), "日期筛选验证用户", "USER");
        long id = users.findByUsername(name).id();
        userFixtures.put(id, name);
        return id;
    }

    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(String name) { return new AppUserDetails(users.findByUsername(name)); }
    private static LocalDateTime utc(Instant value) { return LocalDateTime.ofInstant(value.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC); }
    private static void inOtherThread(Runnable action) {
        try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(15, TimeUnit.SECONDS); }
        catch (Exception failure) { throw new IllegalStateException("Concurrent date fixture cancellation failed to commit", failure); }
    }
}

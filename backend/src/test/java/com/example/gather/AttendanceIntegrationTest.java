package com.example.gather;

import com.example.gather.api.AttendanceModels.*;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AttendanceMapper;
import com.example.gather.mapper.CredentialVersionMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.monitoring.MonitoringService;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.AttendanceService;
import com.example.gather.service.CheckInService;
import com.example.gather.support.OwnedIntegrationFixtures;
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
import java.net.URI;
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

/** Actual MySQL joins, read-only snapshot, statement counts and EXPLAIN; no substitute database. */
@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc
@Import(AttendanceIntegrationTest.Configuration.class)
@ExtendWith(OutputCaptureExtension.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AttendanceIntegrationTest {
    private static final String PATH = "/api/admin/attendance";
    private static final Instant NOW = Instant.parse("2042-03-01T16:00:00.123456789Z");
    private static final Instant AS_OF = NOW.truncatedTo(ChronoUnit.MICROS);
    private static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final String DAY = "2042-02-20";

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary AttendanceClock attendanceClock() { return new AttendanceClock(); }
        @Bean AttendanceReads attendanceReads() { return new AttendanceReads(); }
    }

    static class AttendanceClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return time.get(); }
    }

    record Query(String statement, String sql, List<Object> parameters, boolean readOnly, Integer isolation) {}
    @Intercepts(@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))
    static class AttendanceReads implements Interceptor {
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        final AtomicReference<Runnable> afterTotals = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            List<Query> records = captured.get();
            if (records != null) {
                var bound = statement.getBoundSql(invocation.getArgs()[1]);
                var parameters = statement.getConfiguration().newMetaObject(invocation.getArgs()[1]);
                List<Object> values = new ArrayList<>();
                for (var mapping : bound.getParameterMappings()) values.add(bound.hasAdditionalParameter(mapping.getProperty())
                    ? bound.getAdditionalParameter(mapping.getProperty()) : parameters.getValue(mapping.getProperty()));
                records.add(new Query(statement.getId(), bound.getSql(), values,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                    TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            Object result = invocation.proceed();
            if (statement.getId().equals(AttendanceMapper.class.getName() + ".totals")) {
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
            || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath())) {
            throw new IllegalStateException("Attendance tests require dedicated REAL activity_platform_test MySQL");
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
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityMapper activityMapper;
    @Autowired AttendanceService attendance;
    @Autowired CheckInService checkIns;
    @Autowired PlatformTransactionManager transactions;
    @Autowired AttendanceClock clock;
    @Autowired AttendanceReads reads;
    @Autowired MonitoringService monitoring;
    @Autowired ObjectMapper json;
    private final Map<Long, String> activityFixtures = new LinkedHashMap<>();
    private final Map<Long, String> userFixtures = new LinkedHashMap<>();
    private final List<Long> participants = new ArrayList<>();

    @BeforeEach
    void verifyDedicatedDatabaseBeforeOwnedFixtureWrites() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(11);
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at FROM activities LIMIT 0");
        jdbc.queryForList("SELECT id, checked_in_at, checked_in_by FROM registrations LIMIT 0");
        jdbc.queryForList("SELECT id, activity_id, actor_user_id, registration_id FROM activity_audit_logs LIMIT 0");
    }

    @AfterEach
    void cleanOnlyVerifiedOwnedFixtures() {
        reads.afterTotals.set(null);
        reads.captured.remove();
        clock.time.set(NOW);
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            activityFixtures.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
            userFixtures.forEach((id, username) -> assertThat(jdbc.queryForObject("SELECT username FROM users WHERE id=?", String.class, id)).isEqualTo(username));
            OwnedIntegrationFixtures.remove(jdbc, activityFixtures.keySet(), userFixtures.keySet());
        });
    }

    @Test
    void endpointRequiresAdminAndNeverChangesAnyActivityState() throws Exception {
        long id = fixture(atBeijing(DAY, "12:00:00"), 3, 1, 1, 1, false);
        var before = state(id);
        mvc.perform(get(PATH)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(get(PATH).with(user(principal(demoId())))).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(get(PATH).with(user(principal(adminId()))).param("from", DAY).param("to", DAY)
                .param("userId", Long.toString(demoId())))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1))
            .andExpect(jsonPath("$.summary.activeRegistrations").value(3))
            .andExpect(jsonPath("$.summary.checkedInRegistrations").value(1))
            .andExpect(jsonPath("$.summary.notCheckedInRegistrations").value(2))
            .andExpect(jsonPath("$.items[0].id").value(id)).andExpect(jsonPath("$.items[0].capacity").value(3))
            .andExpect(jsonPath("$.items[0].startsAt").value(atBeijing(DAY, "12:00:00").toString()));
        assertThat(state(id)).isEqualTo(before);
    }

    @Test
    void strictDatesAndPageValidationRejectBeforeAnyBusinessSelect() throws Exception {
        var admin = principal(adminId());
        List<Map<String, String>> invalid = List.of(Map.of("from", DAY), Map.of("to", DAY),
            Map.of("from", "", "to", ""), Map.of("from", " ", "to", DAY),
            Map.of("from", "2042-2-20", "to", DAY), Map.of("from", "+2042-02-20", "to", DAY),
            Map.of("from", "2042-02-30", "to", "2042-03-02"), Map.of("from", "2041-02-29", "to", "2041-03-01"),
            Map.of("from", "2042-02-20T00:00:00", "to", DAY), Map.of("from", "1999-12-31", "to", "2000-01-01"),
            Map.of("from", "2100-12-31", "to", "2101-01-01"), Map.of("from", "2042-02-21", "to", DAY),
            Map.of("from", "2041-01-01", "to", "2042-01-02"), Map.of("page", "0"), Map.of("page", "-1"),
            Map.of("page", "abc"), Map.of("pageSize", "0"), Map.of("pageSize", "101"), Map.of("pageSize", "abc"));
        for (var parameters : invalid) {
            var request = get(PATH).with(user(admin));
            parameters.forEach(request::param);
            var records = capture(() -> {
                try { mvc.perform(request).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR")); }
                catch (Exception failure) { throw new IllegalStateException("Invalid attendance parameters must be rejected", failure); }
            });
            assertThat(records).as("Authenticate once, then reject invalid parameters before business SQL: " + parameters)
                .extracting(query -> query.statement())
                .containsExactly(CredentialVersionMapper.class.getName() + ".findByUserId");
        }
        for (var range : List.of(List.of("2000-01-01", "2000-01-01"), List.of("2100-12-31", "2100-12-31"),
                List.of("2040-01-01", "2040-12-31"), List.of("2041-01-01", "2042-01-01"))) {
            mvc.perform(get(PATH).with(user(admin)).param("from", range.getFirst()).param("to", range.getLast()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.from").value(range.getFirst())).andExpect(jsonPath("$.to").value(range.getLast()));
        }
    }

    @Test
    void defaultRangeUsesSingleMicrosecondNowAndBeijingDate() {
        LocalDate today = NOW.atZone(BEIJING).toLocalDate();
        LocalDate first = today.minusDays(29);
        Instant lower = first.atStartOfDay(BEIJING).toInstant();
        fixture(lower.minus(1, ChronoUnit.MICROS), 0, 0, 0, 0, false);
        long firstIncluded = fixture(lower, 1, 0, 0, 0, false);
        long nowIncluded = fixture(AS_OF, 1, 1, 0, 0, false);
        fixture(AS_OF.plus(1, ChronoUnit.MICROS), 0, 0, 0, 0, false);
        clock.calls.set(0);

        var page = attendance.search(null, null, 1, 10);

        assertThat(clock.calls).hasValue(1);
        assertThat(page.asOf()).isEqualTo(AS_OF);
        assertThat(page.from()).isEqualTo(first.toString());
        assertThat(page.to()).isEqualTo(today.toString());
        assertThat(page.total()).isEqualTo(2);
        assertThat(page.items()).extracting(AttendanceItem::id).containsExactly(nowIncluded, firstIncluded);
        assertThat(page.summary().checkInRate()).isEqualByComparingTo("50.00");
    }

    @Test
    void selectedBeijingDateUsesInclusiveStartAndExclusiveNextMidnight() {
        Instant first = LocalDate.parse(DAY).atStartOfDay(BEIJING).toInstant();
        Instant until = LocalDate.parse(DAY).plusDays(1).atStartOfDay(BEIJING).toInstant();
        fixture(first.minus(1, ChronoUnit.MICROS), 1, 1, 0, 0, false);
        long atStart = fixture(first, 1, 1, 0, 0, false);
        long atEnd = fixture(until.minus(1, ChronoUnit.MICROS), 2, 1, 0, 0, false);
        fixture(until, 1, 1, 0, 0, false);

        var page = attendance.search(DAY, DAY, 1, 10);

        assertThat(page.items()).extracting(AttendanceItem::id).containsExactly(atEnd, atStart);
        assertThat(page.summary()).isEqualTo(new AttendanceSummary(2, 3, 2, 1, new java.math.BigDecimal("66.67")));
    }

    @Test
    void nowBoundaryIsInclusiveAndCancelWaitingAndCancelledRowsAreExcluded() {
        long atNow = fixture(AS_OF, 2, 1, 2, 2, false);
        long beforeNow = fixture(AS_OF.minus(1, ChronoUnit.MICROS), 1, 0, 0, 0, false);
        fixture(AS_OF.plus(1, ChronoUnit.MICROS), 1, 0, 0, 0, false);
        fixture(AS_OF.minusSeconds(1), 0, 0, 0, 4, true);
        String today = NOW.atZone(BEIJING).toLocalDate().toString();

        var page = attendance.search(today, today, 1, 10);

        assertThat(page.total()).isEqualTo(2);
        assertThat(page.items()).extracting(AttendanceItem::id).containsExactly(atNow, beforeNow);
        assertThat(page.summary().activeRegistrations()).isEqualTo(3);
        assertThat(page.summary().checkedInRegistrations()).isEqualTo(1);
        assertThat(page.summary().notCheckedInRegistrations()).isEqualTo(2);
        assertThat(page.summary().checkInRate()).isEqualByComparingTo("33.33");
    }

    @Test
    void summaryUsesTotalRatioRatherThanAverageAndNeverChangesWithPage() {
        long first = fixture(atBeijing(DAY, "10:00:00"), 8, 1, 2, 1, false);
        long second = fixture(atBeijing(DAY, "11:00:00"), 2, 2, 1, 0, false);
        var pageOne = attendance.search(DAY, DAY, 1, 1);
        var pageTwo = attendance.search(DAY, DAY, 2, 1);

        assertThat(pageOne.items().getFirst().id()).isEqualTo(second);
        assertThat(pageOne.items().getFirst().checkInRate()).isEqualByComparingTo("100.00");
        assertThat(pageTwo.items().getFirst().id()).isEqualTo(first);
        assertThat(pageTwo.items().getFirst().checkInRate()).isEqualByComparingTo("12.50");
        assertThat(pageOne.summary()).isEqualTo(pageTwo.summary());
        assertThat(pageOne.summary()).isEqualTo(new AttendanceSummary(2, 10, 3, 7, new java.math.BigDecimal("30.00")));
    }

    @Test
    void ratesRoundHalfUpAndZeroDenominatorsStayNullInJson() throws Exception {
        long rounded = fixture(atBeijing(DAY, "11:00:00"), 32, 1, 0, 0, false);
        long empty = fixture(atBeijing(DAY, "12:00:00"), 0, 0, 0, 2, false);
        var page = attendance.search(DAY, DAY, 1, 10);
        assertThat(page.items().getFirst().id()).isEqualTo(empty);
        assertThat(page.items().getFirst().checkInRate()).isNull();
        assertThat(page.items().getLast().id()).isEqualTo(rounded);
        assertThat(page.items().getLast().checkInRate()).isEqualTo(new java.math.BigDecimal("3.13"));
        assertThat(page.summary().checkInRate()).isEqualTo(new java.math.BigDecimal("3.13"));
        mvc.perform(get(PATH).with(user(principal(adminId()))).param("from", DAY).param("to", DAY))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].checkInRate").value(org.hamcrest.Matchers.nullValue()))
            .andExpect(jsonPath("$.items[1].checkInRate").value(3.13));
    }

    @Test
    void emptySetAndZeroRegistrationActivitiesHaveHonestCountsAndNullRates() throws Exception {
        var empty = attendance.search(DAY, DAY, 1, 10);
        assertThat(empty.total()).isZero();
        assertThat(empty.items()).isEmpty();
        assertThat(empty.summary()).isEqualTo(new AttendanceSummary(0, 0, 0, 0, null));
        fixture(atBeijing(DAY, "11:00:00"), 0, 0, 0, 1, false);
        fixture(atBeijing(DAY, "12:00:00"), 0, 0, 0, 0, false);
        var zero = attendance.search(DAY, DAY, 1, 10);
        assertThat(zero.total()).isEqualTo(2);
        assertThat(zero.summary()).isEqualTo(new AttendanceSummary(2, 0, 0, 0, null));
        assertThat(zero.items()).allSatisfy(row -> {
            assertThat(row.activeRegistrations()).isZero();
            assertThat(row.notCheckedInRegistrations()).isZero();
            assertThat(row.checkInRate()).isNull();
        });
        mvc.perform(get(PATH).with(user(principal(adminId()))).param("from", DAY).param("to", DAY))
            .andExpect(status().isOk()).andExpect(jsonPath("$.summary.checkInRate").value(org.hamcrest.Matchers.nullValue()));
    }

    @Test
    void pagesHaveStableTimeAndIdOrderingAndOutOfRangeRetainsTrueTotal() {
        List<Long> ids = new ArrayList<>();
        Instant same = atBeijing(DAY, "12:00:00");
        for (int index = 0; index < 23; index++) ids.add(fixture(same, 0, 0, 0, 0, false));
        List<Long> actual = new ArrayList<>();
        for (int page = 1; page <= 3; page++) {
            var result = attendance.search(DAY, DAY, page, 10);
            assertThat(result.total()).isEqualTo(23);
            assertThat(result.summary().totalActivities()).isEqualTo(23);
            result.items().forEach(row -> actual.add(row.id()));
        }
        Collections.reverse(ids);
        assertThat(actual).containsExactlyElementsOf(ids).doesNotHaveDuplicates();
        var outside = attendance.search(DAY, DAY, Integer.MAX_VALUE, 100);
        assertThat(outside.total()).isEqualTo(23);
        assertThat(outside.items()).isEmpty();
        long earlierWithLaterId = fixture(same.minusSeconds(1), 0, 0, 0, 0, false);
        assertThat(attendance.search(DAY, DAY, 3, 10).items().getLast().id()).isEqualTo(earlierWithLaterId);
    }

    @Test
    void aggregateAndPageUseTwoReadOnlyRepeatableReadSelectsAndOneClockWithActualExplain() throws Exception {
        fixture(atBeijing(DAY, "12:00:00"), 3, 1, 1, 1, false);
        clock.calls.set(0);
        var queries = capture(() -> attendance.search(DAY, DAY, 1, 10));
        assertThat(clock.calls).hasValue(1);
        assertThat(queries).extracting(Query::statement).containsExactly(AttendanceMapper.class.getName() + ".totals", AttendanceMapper.class.getName() + ".page");
        for (var query : queries) {
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            assertThat(query.sql().toLowerCase(Locale.ROOT)).doesNotContain("date(", "registered_count", "changes_json");
            assertThat(query.parameters().subList(0, 3)).containsExactly(utc(atBeijing(DAY, "00:00:00")),
                utc(LocalDate.parse(DAY).plusDays(1).atStartOfDay(BEIJING).toInstant()), utc(AS_OF));
        }
        StringBuilder evidence = new StringBuilder("# Attendance actual MySQL EXPLAIN\n\n")
            .append("Two business SELECT statements, one UTC microsecond time, read-only REPEATABLE_READ.\n")
            .append("Authenticated HTTP separately adds one credential-version SELECT. Statement counts are not a throughput or latency measurement.\n");
        for (var query : queries) {
            var plan = jdbc.queryForList("EXPLAIN " + query.sql(), query.parameters().toArray());
            assertThat(plan).isNotEmpty();
            assertThat(plan).anySatisfy(row -> assertThat(String.valueOf(row.get("table"))).isEqualTo("a"));
            assertThat(plan).anySatisfy(row -> assertThat(String.valueOf(row.get("table"))).isEqualTo("r"));
            evidence.append("\n## ").append(query.statement()).append("\n\n```sql\n").append(query.sql()).append("\n```\n\n")
                .append("Actual plan rows (no parameter values):\n").append(plan).append("\n");
        }
        Path directory = Path.of("..", ".runtime"); Files.createDirectories(directory);
        Files.writeString(directory.resolve("attendance-query-evidence.md"), evidence.toString(), StandardCharsets.UTF_8);
    }

    @Test
    void authenticatedHttpSeparatesOneCredentialVersionReadFromTwoAttendanceBusinessReads() {
        var identity = principal(adminId());
        var queries = capture(() -> {
            try { mvc.perform(get(PATH).with(user(identity)).param("from", DAY).param("to", DAY)).andExpect(status().isOk()); }
            catch (Exception failure) { throw new IllegalStateException("Authenticated attendance read failed", failure); }
        });
        assertThat(queries).extracting(Query::statement).containsExactly(
            CredentialVersionMapper.class.getName() + ".findByUserId", AttendanceMapper.class.getName() + ".totals",
            AttendanceMapper.class.getName() + ".page");
        assertThat(queries.getFirst().sql()).contains("SELECT credential_version").doesNotContain("password_hash", "FOR UPDATE");
        assertThat(queries.getFirst().parameters()).containsExactly(identity.id());
        assertThat(queries.subList(1, queries.size())).allSatisfy(query -> {
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        });
    }

    @Test
    void concurrentCheckInCannotSplitSummaryFromPageAndNowStaysFixed() {
        long id = fixture(atBeijing(DAY, "12:00:00"), 3, 0, 0, 0, false);
        long registration = jdbc.queryForObject("SELECT MIN(id) FROM registrations WHERE activity_id=?", Long.class, id);
        long future = fixture(AS_OF.plusSeconds(1), 0, 0, 0, 0, false);
        var before = state(id);
        reads.afterTotals.set(() -> {
            clock.time.set(NOW.plusSeconds(60));
            inOtherThread(() -> checkIns.checkIn(id, registration, adminId()));
        });

        var snapshot = attendance.search(null, null, 1, 10);

        assertThat(snapshot.asOf()).isEqualTo(AS_OF);
        assertThat(snapshot.summary().checkedInRegistrations()).isZero();
        assertThat(snapshot.items()).noneSatisfy(row -> assertThat(row.id()).isEqualTo(future));
        assertThat(snapshot.items()).filteredOn(row -> row.id() == id).singleElement().satisfies(row -> assertThat(row.checkedInRegistrations()).isZero());
        var latest = attendance.search(null, null, 1, 10);
        assertThat(latest.summary().checkedInRegistrations()).isEqualTo(1);
        assertThat(latest.items()).extracting(AttendanceItem::id).contains(future);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_id=? AND action='CHECK_IN'", Integer.class, id)).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", id)).isEqualTo(before.get("notifications"));
    }

    @Test
    void routeHasFiniteMetricsAndSafeRequestIdBeforeAndAfterAuthentication(CapturedOutput output) throws Exception {
        var admin = principal(adminId());
        long before = monitoring.snapshot().routes().stream().filter(route -> route.route().equals(PATH)).mapToLong(route -> route.count()).sum();
        String secret = "ATTENDANCE_PRIVATE_QUERY_" + UUID.randomUUID();
        for (boolean authenticated : List.of(false, true)) {
            var request = get(PATH).param("private", secret);
            if (authenticated) request.with(user(admin));
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

    private List<Query> capture(Runnable action) {
        List<Query> records = new ArrayList<>(); reads.captured.set(records);
        try { action.run(); return List.copyOf(records); }
        finally { reads.captured.remove(); }
    }
    private long fixture(Instant startsAt, int active, int checked, int waiting, int cancelled, boolean activityCancelled) {
        while (participants.size() < active + waiting + cancelled) participants.add(createUser());
        String title = "Attendance " + UUID.randomUUID();
        var row = new NewActivity(title, "独立签到分析初始化样例", "北京测试会场", utc(startsAt), Math.max(active, 1), adminId());
        // Started fixtures are initialized directly and accurately; no existing or published demo time is changed.
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            activityMapper.insert(row);
            activityFixtures.put(row.id, title);
            for (int index = 0; index < active + waiting + cancelled; index++) {
                String status = index < active ? "ACTIVE" : index < active + waiting ? "WAITING" : "CANCELLED";
                boolean attended = index < checked;
                jdbc.update("INSERT INTO registrations(activity_id,user_id,status,checked_in_at,checked_in_by) VALUES(?,?,?,?,?)",
                    row.id, participants.get(index), status, attended ? utc(AS_OF) : null, attended ? adminId() : null);
            }
            jdbc.update("UPDATE activities SET registered_count=? WHERE id=?", active, row.id);
            if (activityCancelled) jdbc.update("UPDATE activities SET cancelled_at=?,cancellation_reason=?,cancelled_by=? WHERE id=?",
                utc(AS_OF), "独立样例已取消", adminId(), row.id);
        });
        return row.id;
    }
    private long createUser() {
        String username = "attendance_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "签到分析参与者", "USER");
        long id = users.findByUsername(username).id(); userFixtures.put(id, username); return id;
    }
    private Map<String, Object> state(long activityId) {
        return Map.of("activity", jdbc.queryForMap("SELECT * FROM activities WHERE id=?", activityId),
            "registrations", jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", activityId),
            "notifications", jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", activityId),
            "audit", jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", activityId));
    }
    private long adminId() { return users.findByUsername("admin").id(); }
    private long demoId() { return users.findByUsername("demo").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static Instant atBeijing(String day, String time) { return LocalDateTime.parse(day + "T" + time).atZone(BEIJING).toInstant(); }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC); }
    private static void inOtherThread(Runnable action) {
        try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(20, TimeUnit.SECONDS); }
        catch (Exception failure) { throw new IllegalStateException("Concurrent fixture writer did not commit", failure); }
    }
}

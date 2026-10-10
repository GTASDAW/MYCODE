package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.RegistrationService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL transactions, row locks, constraints and owned fixture cleanup only. */
@SpringBootTest
@AutoConfigureMockMvc
@Import(ActivityLifecycleIntegrationTest.TimeConfiguration.class)
class ActivityLifecycleIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-04-10T09:00:00.123456Z");

    static class MutableClock extends Clock {
        private final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return time.get(); }
        void set(Instant instant) { time.set(instant); }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TimeConfiguration {
        @Bean @Primary MutableClock lifecycleClock() { return new MutableClock(); }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !url.contains("/activity_platform_test?")) {
            throw new IllegalStateException("Lifecycle integration tests require the dedicated REAL activity_platform_test MySQL database.");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }

    private static String environment(String key, String fallback) {
        String value = System.getenv(key);
        return value == null ? fallback : value;
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired UserMapper users;
    @Autowired ActivityMapper mapper;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired AdminService admin;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MutableClock clock;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanOnlyCreatedFixtures() {
        clock.set(NOW);
        for (long id : activityIds) {
            jdbc.update("DELETE FROM notifications WHERE activity_id=?", id);
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
        for (long id : userIds) jdbc.update("DELETE FROM users WHERE id=?", id);
    }

    @Test
    void editChangesOnlyAllowedFieldsAndRetainsRegistrationHistory() throws Exception {
        long id = createActivity(1);
        long userId = createUser();
        registrations.register(id, userId);
        var before = activities.get(id, userId);
        var history = registrationRows(id);
        String body = json.writeValueAsString(java.util.Map.of("title", "  新标题  ", "description", " 新介绍\n下一行 ",
            "location", " 新地点 ", "capacity", 999, "startsAt", "2040-01-01T00:00:00Z", "cancelledBy", userId));
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal("admin"))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.title").value("新标题"))
            .andExpect(jsonPath("$.description").value("新介绍\n下一行")).andExpect(jsonPath("$.location").value("新地点"))
            .andExpect(jsonPath("$.capacity").value(1)).andExpect(jsonPath("$.cancelled").value(false));
        var edited = activities.get(id, userId);
        assertThat(edited.startsAt()).isEqualTo(before.startsAt());
        assertThat(edited.registeredCount()).isEqualTo(1);
        assertThat(edited.registrationStatus()).isEqualTo("ACTIVE");
        assertThat(registrationRows(id)).isEqualTo(history);
        mvc.perform(get("/api/activities/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.title").value("新标题"));
    }

    @Test
    void editAndCancelRequireAdminAndCsrf() throws Exception {
        long id = createActivity(1);
        for (boolean cancelling : List.of(false, true)) {
            String path = "/api/admin/activities/" + id + (cancelling ? "/cancel" : "");
            String body = cancelling ? "{\"reason\":\"场地调整\"}" : editBody();
            var anonymous = cancelling ? post(path) : patch(path);
            mvc.perform(anonymous.with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
            var ordinary = cancelling ? post(path) : patch(path);
            mvc.perform(ordinary.with(user(principal("demo"))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
            var noCsrf = cancelling ? post(path) : patch(path);
            mvc.perform(noCsrf.with(user(principal("admin"))).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        }
        assertThat(activities.get(id, null).cancelled()).isFalse();
    }

    @Test
    void invalidFieldsAndReasonsDoNotModifyActivity() throws Exception {
        long id = createActivity(1);
        var before = activities.get(id, null);
        for (String body : List.of("{\"title\":\" \",\"description\":\"d\",\"location\":\"l\"}",
            json.writeValueAsString(new EditActivityRequest("x".repeat(101), "d", "l")), "{\"title\":\"x\"}")) {
            mvc.perform(patch("/api/admin/activities/" + id).with(user(principal("admin"))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        for (String reason : List.of(" ", "x".repeat(501), "x\ny", "x\ty", "x\u0085y", "\nreason\n",
            "x\u2028y", "x\u2029y", "\u2028reason\u2028", "\u2029reason\u2029")) {
            mvc.perform(post("/api/admin/activities/" + id + "/cancel").with(user(principal("admin"))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(new CancelActivityRequest(reason))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        assertThat(activities.get(id, null)).isEqualTo(before);
        for (boolean cancelling : List.of(false, true)) {
            var request = cancelling ? post("/api/admin/activities/9223372036854775807/cancel") : patch("/api/admin/activities/9223372036854775807");
            mvc.perform(request.with(user(principal("admin"))).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(cancelling ? "{\"reason\":\"场地调整\"}" : editBody()))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("ACTIVITY_NOT_FOUND"));
        }
    }

    @Test
    void cancellationPreservesAllIdsAndAlreadyCancelledTimestampsWithoutPromotion() throws Exception {
        long id = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        long alreadyCancelled = createUser();
        registrations.register(id, active);
        registrations.register(id, waiting);
        registrations.register(id, alreadyCancelled);
        registrations.cancel(id, alreadyCancelled);
        var before = registrationRows(id);
        var existingCancelled = jdbc.queryForMap("SELECT * FROM registrations WHERE activity_id=? AND user_id=?", id, alreadyCancelled);
        mvc.perform(post("/api/admin/activities/" + id + "/cancel").with(user(principal("admin"))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"  场地临时关闭  \"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.cancelled").value(true)).andExpect(jsonPath("$.closed").value(true))
            .andExpect(jsonPath("$.cancellationReason").value("场地临时关闭"))
            .andExpect(jsonPath("$.cancelledAt").value(NOW.toString())).andExpect(jsonPath("$.registeredCount").value(0))
            .andExpect(jsonPath("$.waitingCount").value(0));
        assertThat(registrationRows(id)).extracting(row -> row.get("id")).containsExactlyElementsOf(before.stream().map(row -> row.get("id")).toList());
        assertThat(registrationRows(id)).extracting(row -> row.get("status")).containsOnly("CANCELLED");
        assertThat(jdbc.queryForMap("SELECT * FROM registrations WHERE activity_id=? AND user_id=?", id, alreadyCancelled)).isEqualTo(existingCancelled);
        assertThat(jdbc.queryForObject("SELECT cancelled_by FROM activities WHERE id=?", Long.class, id)).isEqualTo(adminId());
        assertThat(registrations.mine(active)).anySatisfy(row -> {
            assertThat(row.activity().id()).isEqualTo(id);
            assertThat(row.status()).isEqualTo("CANCELLED");
            assertThat(row.activity().cancellationReason()).isEqualTo("场地临时关闭");
        });
        assertZeroInvariant(id);
    }

    @Test
    void repeatCancellationRetainsFirstReasonTimeAndHistoryEvenAfterStart() {
        long id = createActivity(1);
        registrations.register(id, createUser());
        activities.cancel(id, new CancelActivityRequest("首次原因"), adminId());
        var first = activities.get(id, null);
        var rows = registrationRows(id);
        clock.set(NOW.plusSeconds(7200));
        var second = activities.cancel(id, new CancelActivityRequest("第二次原因"), adminId());
        assertThat(second).isEqualTo(first);
        assertThat(registrationRows(id)).isEqualTo(rows);
        assertZeroInvariant(id);
    }

    @Test
    void startedActivitiesCannotBeEditedOrCancelledAndCancelledWritesRemainClosed() throws Exception {
        long started = createActivity(1);
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(NOW), started);
        expectCode(() -> activities.edit(started, editRequest(), adminId()), "ACTIVITY_CLOSED");
        expectCode(() -> activities.cancel(started, new CancelActivityRequest("原因"), adminId()), "ACTIVITY_CLOSED");
        long cancelled = createActivity(1);
        activities.cancel(cancelled, new CancelActivityRequest("原因"), adminId());
        expectCode(() -> activities.edit(cancelled, editRequest(), adminId()), "ACTIVITY_CANCELLED");
        for (boolean cancelling : List.of(false, true)) {
            var request = cancelling ? delete("/api/activities/" + cancelled + "/registration") : post("/api/activities/" + cancelled + "/registration");
            mvc.perform(request.with(user(principal("demo"))).with(csrf())).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("ACTIVITY_CANCELLED"));
        }
        assertZeroInvariant(cancelled);
    }

    @Test
    void cancelledStatusFiltersAndOverviewExcludeCancelledSeatsEvenAfterStart() throws Exception {
        var before = admin.overview();
        String prefix = "LifecycleFilter " + UUID.randomUUID();
        long cancelled = createActivity(prefix, 1);
        registrations.register(cancelled, createUser());
        registrations.register(cancelled, createUser());
        activities.cancel(cancelled, new CancelActivityRequest("原因"), adminId());
        long open = createActivity(prefix, 2);
        var after = admin.overview();
        assertThat(after.totalActivities() - before.totalActivities()).isEqualTo(2);
        assertThat(after.cancelledActivities() - before.cancelledActivities()).isEqualTo(1);
        assertThat(after.upcomingActivities() - before.upcomingActivities()).isEqualTo(1);
        assertThat(after.startedActivities()).isEqualTo(before.startedActivities());
        assertThat(after.fullActivities()).isEqualTo(before.fullActivities());
        assertThat(after.activeRegistrations()).isEqualTo(before.activeRegistrations());
        assertThat(after.waitingRegistrations()).isEqualTo(before.waitingRegistrations());
        assertThat(after.availableSeats() - before.availableSeats()).isEqualTo(2);
        assertThat(after.upcomingActivities() + after.startedActivities() + after.cancelledActivities()).isEqualTo(after.totalActivities());
        for (String status : List.of("OPEN", "FULL", "UPCOMING", "STARTED")) {
            assertThat(admin.activities(1, 100, prefix, status, adminId()).items()).noneMatch(row -> row.id() == cancelled);
        }
        assertThat(admin.activities(1, 100, prefix, "ALL", adminId()).items()).extracting(ActivityView::id).containsExactly(cancelled, open);
        assertThat(admin.activities(1, 100, prefix, "CANCELLED", adminId()).items()).extracting(ActivityView::id).containsExactly(cancelled);
        var roster = admin.roster(cancelled, 1, 100, "ALL", adminId());
        assertThat(roster.total()).isEqualTo(2);
        assertThat(roster.items()).extracting(row -> row.status()).containsOnly("CANCELLED");
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(NOW.minusSeconds(1)), cancelled);
        assertThat(admin.activities(1, 100, prefix, "STARTED", adminId()).items()).isEmpty();
        mvc.perform(get("/api/admin/activities").param("status", "CANCELLED").param("keyword", prefix).with(user(principal("admin"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].cancelled").value(true));
    }

    @Test
    void failureAfterCancellingRegistrationsRollsBackWholeTransaction() {
        long id = createActivity(1);
        registrations.register(id, createUser());
        registrations.register(id, createUser());
        var activityBefore = activities.get(id, null);
        var registrationsBefore = registrationRows(id);
        // Registration UPDATE has already run when cancelled_by violates its foreign key.
        assertThatThrownBy(() -> activities.cancel(id, new CancelActivityRequest("原因"), Long.MAX_VALUE))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(activities.get(id, null)).isEqualTo(activityBefore);
        assertThat(registrationRows(id)).isEqualTo(registrationsBefore);
        assertThat(jdbc.queryForObject("SELECT cancelled_by FROM activities WHERE id=?", Long.class, id)).isNull();
    }

    @Test
    void databaseRejectsPartialCancellationAndNonzeroCancelledCounter() {
        long id = createActivity(1);
        expectMysqlCheckViolation(() -> jdbc.update("UPDATE activities SET cancellation_reason='only reason' WHERE id=?", id));
        activities.cancel(id, new CancelActivityRequest("原因"), adminId());
        expectMysqlCheckViolation(() -> jdbc.update("UPDATE activities SET registered_count=1 WHERE id=?", id));
        assertZeroInvariant(id);
    }

    @Test
    void concurrentActivityCancellationKeepsFirstReasonAndTime() throws Exception {
        long id = createActivity(1);
        registrations.register(id, createUser());
        var first = new AtomicReference<ActivityView>();
        var second = new AtomicReference<ActivityView>();
        runWhileFirstOwnsLock(id,
            () -> first.set(activities.cancel(id, new CancelActivityRequest("首次原因"), adminId())),
            () -> second.set(activities.cancel(id, new CancelActivityRequest("另一个管理员的原因"), adminId())));
        assertThat(second.get()).isEqualTo(first.get());
        assertZeroInvariant(id);
    }

    @Test
    void signupAndActivityCancellationSerializeInBothLockOrders() throws Exception {
        long userId = createUser();
        long signupFirst = createActivity(1);
        runWhileFirstOwnsLock(signupFirst, () -> registrations.register(signupFirst, userId),
            () -> activities.cancel(signupFirst, new CancelActivityRequest("原因"), adminId()));
        assertThat(activities.get(signupFirst, userId).registrationStatus()).isEqualTo("CANCELLED");
        assertZeroInvariant(signupFirst);
        long cancelFirst = createActivity(1);
        runWhileFirstOwnsLock(cancelFirst, () -> activities.cancel(cancelFirst, new CancelActivityRequest("原因"), adminId()),
            () -> expectCode(() -> registrations.register(cancelFirst, userId), "ACTIVITY_CANCELLED"));
        assertThat(registrationRows(cancelFirst)).isEmpty();
        assertZeroInvariant(cancelFirst);
    }

    @Test
    void userCancellationAndActivityCancellationSerializeInBothLockOrders() throws Exception {
        long active = createUser();
        long waiting = createUser();
        for (boolean adminFirst : List.of(false, true)) {
            long id = createActivity(1);
            registrations.register(id, active);
            registrations.register(id, waiting);
            if (adminFirst) {
                runWhileFirstOwnsLock(id, () -> activities.cancel(id, new CancelActivityRequest("原因"), adminId()),
                    () -> expectCode(() -> registrations.cancel(id, active), "ACTIVITY_CANCELLED"));
            } else {
                runWhileFirstOwnsLock(id, () -> registrations.cancel(id, active),
                    () -> activities.cancel(id, new CancelActivityRequest("原因"), adminId()));
            }
            assertThat(registrationRows(id)).extracting(row -> row.get("status")).containsOnly("CANCELLED");
            assertZeroInvariant(id);
        }
    }

    @Test
    void editAndActivityCancellationSerializeInBothLockOrders() throws Exception {
        long editFirst = createActivity(1);
        runWhileFirstOwnsLock(editFirst, () -> activities.edit(editFirst, editRequest(), adminId()),
            () -> activities.cancel(editFirst, new CancelActivityRequest("原因"), adminId()));
        assertThat(activities.get(editFirst, null).title()).isEqualTo("Updated title");
        assertZeroInvariant(editFirst);
        long cancelFirst = createActivity(1);
        String original = activities.get(cancelFirst, null).title();
        runWhileFirstOwnsLock(cancelFirst, () -> activities.cancel(cancelFirst, new CancelActivityRequest("原因"), adminId()),
            () -> expectCode(() -> activities.edit(cancelFirst, editRequest(), adminId()), "ACTIVITY_CANCELLED"));
        assertThat(activities.get(cancelFirst, null).title()).isEqualTo(original);
        assertZeroInvariant(cancelFirst);
    }

    @Test
    void editAndCancellationCheckStartTimeAfterAcquiringLock() throws Exception {
        for (boolean cancelling : List.of(false, true)) {
            clock.set(NOW);
            long id = createActivity(1);
            runWhileFirstOwnsLock(id, () -> {}, () -> {
                if (cancelling) expectCode(() -> activities.cancel(id, new CancelActivityRequest("原因"), adminId()), "ACTIVITY_CLOSED");
                else expectCode(() -> activities.edit(id, editRequest(), adminId()), "ACTIVITY_CLOSED");
            }, () -> clock.set(NOW.plusSeconds(3600)));
            assertThat(activities.get(id, null).cancelled()).isFalse();
        }
    }

    private void runWhileFirstOwnsLock(long id, Runnable first, Runnable second) throws Exception {
        runWhileFirstOwnsLock(id, first, second, () -> {});
    }

    private void runWhileFirstOwnsLock(long id, Runnable first, Runnable second, Runnable beforeRelease) throws Exception {
        var tx = new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        var started = new CountDownLatch(1);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var future = tx.execute(status -> {
                mapper.lockById(id);
                first.run();
                var queued = executor.submit(() -> { started.countDown(); second.run(); });
                try {
                    assertThat(started.await(10, TimeUnit.SECONDS)).isTrue();
                    assertThat(queued.isDone()).isFalse();
                    beforeRelease.run();
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(exception);
                }
                return queued;
            });
            future.get(30, TimeUnit.SECONDS);
        }
    }

    private long createActivity(int capacity) { return createActivity("Lifecycle " + UUID.randomUUID(), capacity); }
    private long createActivity(String title, int capacity) {
        long id = activities.create(new CreateActivityRequest(title, "Lifecycle fixture", "Test venue", NOW.plusSeconds(3600), capacity), adminId()).id();
        activityIds.add(id);
        return id;
    }

    private long createUser() {
        String username = "lifecycle_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Lifecycle fixture user", "USER");
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(String username) { return new AppUserDetails(users.findByUsername(username)); }
    private static EditActivityRequest editRequest() { return new EditActivityRequest("Updated title", "Updated description", "Updated venue"); }
    private String editBody() { return json.writeValueAsString(editRequest()); }
    private static LocalDateTime utc(Instant instant) { return LocalDateTime.ofInstant(instant, ZoneOffset.UTC); }
    private List<java.util.Map<String, Object>> registrationRows(long id) {
        return jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", id);
    }

    private static void expectCode(Runnable operation, String code) {
        assertThatThrownBy(operation::run).isInstanceOf(ApiException.class)
            .satisfies(error -> assertThat(((ApiException) error).code()).isEqualTo(code));
    }

    private static void expectMysqlCheckViolation(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOf(DataAccessException.class)
            .hasRootCauseInstanceOf(SQLException.class).satisfies(error -> {
                // MySQL 8.4 CHECK failures use HY000/3819, which Spring's generic translator
                // may classify as UncategorizedSQLException rather than an integrity subtype.
                assertThat(((SQLException) error.getCause()).getErrorCode()).isEqualTo(3819);
            });
    }

    private void assertZeroInvariant(long id) {
        var view = activities.get(id, null);
        assertThat(view.cancelled()).isTrue();
        assertThat(view.registeredCount()).isZero();
        assertThat(view.waitingCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status IN ('ACTIVE','WAITING')", Integer.class, id)).isZero();
    }
}

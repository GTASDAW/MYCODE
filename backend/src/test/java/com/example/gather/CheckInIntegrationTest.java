package com.example.gather;

import com.example.gather.api.AdminModels.*;
import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.CheckInService;
import com.example.gather.service.RegistrationService;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL locks, snapshot reads, constraints and bounded exports; never uses an in-memory substitute. */
@SpringBootTest
@AutoConfigureMockMvc
@Import(CheckInIntegrationTest.Configuration.class)
@ExtendWith(OutputCaptureExtension.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class CheckInIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-08-01T09:00:00.123456Z");

    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary MutableClock checkInClock() { return new MutableClock(); }
        @Bean CheckInInterceptor checkInInterceptor() { return new CheckInInterceptor(); }
    }

    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return time.get(); }
    }

    record Hook(String statement, boolean before, Runnable action) {}
    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class CheckInInterceptor implements Interceptor {
        final AtomicReference<Hook> hook = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            String id = ((MappedStatement) invocation.getArgs()[0]).getId();
            Hook next = hook.get();
            if (next != null && id.equals(next.statement()) && hook.compareAndSet(next, null)) {
                if (next.before()) next.action().run();
                var result = invocation.proceed();
                if (!next.before()) next.action().run();
                return result;
            }
            return invocation.proceed();
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !java.net.URI.create(url.substring("jdbc:".length())).getPath().equals("/activity_platform_test")) {
            throw new IllegalStateException("Check-in tests require the dedicated REAL activity_platform_test MySQL database");
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
    @Autowired ActivityMapper activityMapper;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired AdminService admin;
    @Autowired CheckInService checkIns;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MutableClock clock;
    @Autowired CheckInInterceptor hooks;
    @Autowired ObjectMapper json;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanOnlyOwnedFixturesAndProtectExternalCheckInReferences() {
        hooks.hook.set(null);
        clock.time.set(NOW);
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            for (int start = 0; start < userIds.size(); start += 500) {
                var batch = userIds.subList(start, Math.min(start + 500, userIds.size()));
                String marks = String.join(",", Collections.nCopies(batch.size(), "?"));
                for (String query : List.of("SELECT activity_id FROM registrations WHERE checked_in_by IN (" + marks + ")",
                    "SELECT activity_id FROM registrations WHERE user_id IN (" + marks + ")",
                    "SELECT activity_id FROM notifications WHERE user_id IN (" + marks + ")")) {
                    assertThat(jdbc.queryForList(query, Long.class, batch.toArray())).allMatch(activityIds::contains);
                }
                assertThat(jdbc.queryForList("SELECT id FROM activities WHERE created_by IN (" + marks + ") OR cancelled_by IN (" + marks + ")",
                    Long.class, java.util.stream.Stream.concat(batch.stream(), batch.stream()).toArray())).allMatch(activityIds::contains);
            }
            com.example.gather.support.OwnedIntegrationFixtures.remove(jdbc, activityIds, userIds);
        });
    }

    @Test
    void checkInAndExportRequireAdminCsrfAndIgnoreClientActor() throws Exception {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "签到参与者"));
        start(activity, NOW);
        for (String path : List.of(rosterPath(activity), exportPath(activity))) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
            mvc.perform(get(path).with(user(principal(demoId())))).andExpect(status().isForbidden());
            mvc.perform(get(path).with(user(principal(adminId())))).andExpect(status().isOk());
        }
        mvc.perform(post(checkInPath(activity, registration)).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(post(checkInPath(activity, registration)).with(user(principal(demoId()))).with(csrf()))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(post(checkInPath(activity, registration)).with(user(principal(adminId()))))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(post(checkInPath(activity, registration)).with(user(principal(adminId()))).with(csrf())
            .param("adminId", Long.toString(demoId())).contentType(MediaType.APPLICATION_JSON)
            .content("{\"checkedInBy\":" + demoId() + ",\"checkedInAt\":\"2040-01-01T00:00:00Z\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkedInBy").value(adminId()))
            .andExpect(jsonPath("$.checkedInAt").value(NOW.toString()));
    }

    @Test
    void exactStartBoundaryMicrosecondPrecisionAndLateSupplementAreAllowed() {
        long activity = createActivity(3);
        long first = register(activity, createUser("USER", "开始边界"));
        long late = register(activity, createUser("USER", "后补"));
        start(activity, NOW.plusNanos(1000));
        expectCode(() -> checkIns.checkIn(activity, first, adminId()), "CHECK_IN_NOT_OPEN");
        clock.time.set(NOW.plusNanos(1999));
        assertThat(checkIns.checkIn(activity, first, adminId()).checkedInAt()).isEqualTo(NOW.plusNanos(1000));
        clock.time.set(NOW.plusSeconds(90L * 86400));
        assertThat(checkIns.checkIn(activity, late, adminId()).checkedInAt()).isEqualTo(clock.instant());
    }

    @Test
    void missingCrossActivityWaitingCancelledAndCancelledActivityCannotCheckIn() throws Exception {
        long activity = createActivity(1);
        long active = register(activity, createUser("USER", "有效"));
        long waiting = register(activity, createUser("USER", "候补"));
        long cancelledUser = createUser("USER", "退出候补");
        long cancelled = register(activity, cancelledUser);
        registrations.cancel(activity, cancelledUser);
        long other = createActivity(1);
        long foreign = register(other, createUser("USER", "其他活动"));
        start(activity, NOW);
        expectCode(() -> checkIns.checkIn(Long.MAX_VALUE, active, adminId()), "ACTIVITY_NOT_FOUND");
        for (long id : List.of(Long.MAX_VALUE, foreign)) expectCode(() -> checkIns.checkIn(activity, id, adminId()), "REGISTRATION_NOT_FOUND");
        for (long id : List.of(waiting, cancelled)) expectCode(() -> checkIns.checkIn(activity, id, adminId()), "REGISTRATION_NOT_ACTIVE");
        long cancelledActivity = createActivity(1);
        long cancelledRegistration = register(cancelledActivity, createUser("USER", "整场取消"));
        activities.cancel(cancelledActivity, new CancelActivityRequest("取消原因"), adminId());
        start(cancelledActivity, NOW);
        expectCode(() -> checkIns.checkIn(cancelledActivity, cancelledRegistration, adminId()), "ACTIVITY_CANCELLED");
        mvc.perform(post(checkInPath(activity, foreign)).with(user(principal(adminId()))).with(csrf()))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("REGISTRATION_NOT_FOUND"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND checked_in_at IS NOT NULL", Long.class, activity)).isZero();
    }

    @Test
    void checkInPreservesBusinessCountsQueueTimesAndNotificationsAndFirstAudit() {
        long activity = createActivity(1);
        long active = register(activity, createUser("USER", "有效"));
        register(activity, createUser("USER", "候补"));
        var before = registrationRows(activity);
        var activityBefore = activities.get(activity, null);
        start(activity, NOW);
        long firstAdmin = createUser("ADMIN", "首次签到管理员");
        var first = checkIns.checkIn(activity, active, firstAdmin);
        long secondAdmin = createUser("ADMIN", "后来的管理员");
        clock.time.set(NOW.plusSeconds(3600));
        assertThat(checkIns.checkIn(activity, active, secondAdmin)).isEqualTo(first);
        assertThat(registrationRows(activity)).extracting(row -> row.get("id"), row -> row.get("status"), row -> row.get("updated_at"), row -> row.get("created_at"))
            .containsExactlyElementsOf(before.stream().map(row -> org.assertj.core.groups.Tuple.tuple(row.get("id"), row.get("status"), row.get("updated_at"), row.get("created_at"))).toList());
        assertThat(activities.get(activity, null).registeredCount()).isEqualTo(activityBefore.registeredCount());
        assertThat(activities.get(activity, null).waitingCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Long.class, activity)).isZero();
        jdbc.update("UPDATE users SET display_name=? WHERE id=?", "更新后的管理员昵称", firstAdmin);
        assertThat(checkIns.checkIn(activity, active, secondAdmin).checkedInByDisplayName()).isEqualTo("更新后的管理员昵称");
    }

    @Test
    void concurrentAdministratorsKeepOneFirstTimestampAndActor() throws Exception {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "并发参与者"));
        long anotherAdmin = createUser("ADMIN", "另一个管理员");
        start(activity, NOW);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            var ready = new CountDownLatch(1);
            var futures = new ArrayList<Future<RosterView>>();
            for (int i = 0; i < 16; i++) {
                long actor = i % 2 == 0 ? adminId() : anotherAdmin;
                futures.add(pool.submit(() -> { assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue(); return checkIns.checkIn(activity, registration, actor); }));
            }
            ready.countDown();
            var first = futures.getFirst().get(20, TimeUnit.SECONDS);
            for (var future : futures) assertThat(future.get(20, TimeUnit.SECONDS)).isEqualTo(first);
            assertThat(first.checkedInAt()).isEqualTo(NOW);
            assertThat(first.checkedInBy()).isIn(adminId(), anotherAdmin);
        }
    }

    @Test
    void failedMysqlWriteAfterCheckInRollsBackAuditWithoutBusinessSideEffects() {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "回滚"));
        start(activity, NOW);
        var before = registrationRows(activity);
        hooks.hook.set(new Hook(AdminMapper.class.getName() + ".checkIn", false,
            () -> jdbc.update("UPDATE activities SET registered_count=-1 WHERE id=?", activity)));
        assertThatThrownBy(() -> checkIns.checkIn(activity, registration, adminId())).isInstanceOf(DataAccessException.class);
        assertThat(hooks.hook.get()).isNull();
        assertThat(registrationRows(activity)).isEqualTo(before);
        assertThat(activities.get(activity, null).registeredCount()).isEqualTo(1);
    }

    @Test
    void databaseRejectsPartialNonActiveAndUnknownActorCheckInAudit() {
        long activity = createActivity(1);
        long active = register(activity, createUser("USER", "有效"));
        long waiting = register(activity, createUser("USER", "候补"));
        for (String sql : List.of("UPDATE registrations SET checked_in_at=UTC_TIMESTAMP(6) WHERE id=?",
            "UPDATE registrations SET checked_in_by=" + adminId() + " WHERE id=?")) {
            assertThatThrownBy(() -> jdbc.update(sql, active)).isInstanceOf(DataAccessException.class);
        }
        assertThatThrownBy(() -> jdbc.update("UPDATE registrations SET checked_in_at=?,checked_in_by=? WHERE id=?", utc(NOW), adminId(), waiting))
            .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE registrations SET checked_in_at=?,checked_in_by=? WHERE id=?", utc(NOW), Long.MAX_VALUE, active))
            .isInstanceOf(DataAccessException.class);
    }

    @Test
    void waitingForActivityLockChecksClockOnlyAfterItWasAcquired() throws Exception {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "等待跨边界"));
        start(activity, NOW.plusSeconds(1));
        var tx = new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        var entered = new CountDownLatch(1);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var future = tx.execute(status -> {
                activityMapper.lockById(activity);
                hooks.hook.set(new Hook(ActivityMapper.class.getName() + ".lockById", true, entered::countDown));
                var result = pool.submit(() -> checkIns.checkIn(activity, registration, adminId()));
                await(entered);
                assertThat(result.isDone()).isFalse();
                clock.time.set(NOW.plusSeconds(1));
                return result;
            });
            assertThat(future.get(20, TimeUnit.SECONDS).checkedInAt()).isEqualTo(NOW.plusSeconds(1));
        }
    }

    @Test
    void cancellationBeforeStartAndCheckInAfterStartUseTheSameParentLock() throws Exception {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "取消先到"));
        start(activity, NOW.plusSeconds(1));
        var tx = new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        var entered = new CountDownLatch(1);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var future = tx.execute(status -> {
                activityMapper.lockById(activity);
                activities.cancel(activity, new CancelActivityRequest("边界前取消"), adminId());
                hooks.hook.set(new Hook(ActivityMapper.class.getName() + ".lockById", true, entered::countDown));
                var queued = pool.submit(() -> expectCode(() -> checkIns.checkIn(activity, registration, adminId()), "ACTIVITY_CANCELLED"));
                await(entered);
                assertThat(queued.isDone()).isFalse();
                clock.time.set(NOW.plusSeconds(1));
                return queued;
            });
            future.get(20, TimeUnit.SECONDS);
        }
        assertThat(jdbc.queryForObject("SELECT checked_in_at FROM registrations WHERE id=?", LocalDateTime.class, registration)).isNull();
        assertThat(activities.get(activity, null).registeredCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Long.class, activity)).isEqualTo(1);
    }

    @Test
    void rosterFiltersAndPaginationKeepWholeActivitySummaryAndStableOrder() throws Exception {
        long activity = createActivity(3);
        long first = register(activity, createUser("USER", "一"));
        long second = register(activity, createUser("USER", "二"));
        long third = register(activity, createUser("USER", "三"));
        long waiting = register(activity, createUser("USER", "四"));
        long cancelledUser = createUser("USER", "五");
        long cancelled = register(activity, cancelledUser);
        registrations.cancel(activity, cancelledUser);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=?", utc(NOW.minusSeconds(60)), activity);
        start(activity, NOW);
        checkIns.checkIn(activity, first, adminId());
        var expected = new RosterSummaryView(3, 1, 2);
        for (String status : List.of("ALL", "ACTIVE", "WAITING", "CANCELLED")) {
            for (String checkIn : List.of("ALL", "CHECKED_IN", "NOT_CHECKED_IN")) {
                assertThat(admin.roster(activity, 1, 1, status, checkIn, adminId()).summary()).isEqualTo(expected);
            }
        }
        assertThat(admin.roster(activity, 1, 10, "ALL", "ALL", adminId()).items()).extracting(RosterView::id)
            .containsExactly(cancelled, waiting, third, second, first);
        assertThat(admin.roster(activity, 1, 10, "ALL", "CHECKED_IN", adminId()).items()).extracting(RosterView::id).containsExactly(first);
        assertThat(admin.roster(activity, 1, 10, "ALL", "NOT_CHECKED_IN", adminId()).items()).extracting(RosterView::id).containsExactly(third, second);
        assertThat(admin.roster(activity, 1, 10, "WAITING", "NOT_CHECKED_IN", adminId()).total()).isZero();
        mvc.perform(get(rosterPath(activity)).with(user(principal(adminId()))).param("page", "2").param("pageSize", "1")
            .param("status", "ACTIVE").param("checkInStatus", "NOT_CHECKED_IN"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].id").value(second))
            .andExpect(jsonPath("$.total").value(2)).andExpect(jsonPath("$.summary.activeRegistrations").value(3))
            .andExpect(jsonPath("$.summary.checkedInRegistrations").value(1)).andExpect(jsonPath("$.summary.notCheckedInRegistrations").value(2));
        assertThat(admin.roster(activity, Integer.MAX_VALUE, 100, "ALL", "ALL", adminId()).items()).isEmpty();
    }

    @Test
    void rosterSummaryCountAndRowsShareSnapshotWhenAnotherCheckInCommitsBetweenReads() {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "快照"));
        start(activity, NOW);
        hooks.hook.set(new Hook(AdminMapper.class.getName() + ".rosterSummary", false,
            () -> inOtherThread(() -> checkIns.checkIn(activity, registration, adminId()))));
        var snapshot = admin.roster(activity, 1, 10, "ALL", "NOT_CHECKED_IN", adminId());
        assertThat(snapshot.summary()).isEqualTo(new RosterSummaryView(1, 0, 1));
        assertThat(snapshot.total()).isEqualTo(1);
        assertThat(snapshot.items()).hasSize(1).allMatch(row -> row.checkedInAt() == null);
        assertThat(admin.roster(activity, 1, 10, "ALL", "NOT_CHECKED_IN", adminId()).summary()).isEqualTo(new RosterSummaryView(1, 1, 0));
    }

    @Test
    void invalidFiltersAndMissingExportActivityReturnJsonErrors() throws Exception {
        long activity = createActivity(1);
        for (String path : List.of(rosterPath(activity), exportPath(activity))) {
            for (String value : List.of("UNKNOWN", "checked_in", "ACTIVE")) {
                mvc.perform(get(path).with(user(principal(adminId()))).param("checkInStatus", value))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            }
            mvc.perform(get(path).with(user(principal(adminId()))).param("status", "CHECKED_IN"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        mvc.perform(get(exportPath(Long.MAX_VALUE)).with(user(principal(adminId()))))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("ACTIVITY_NOT_FOUND"));
    }

    @Test
    void exportIncludesEveryFilteredRowBeyondFirstPageAndEmptyExportOnlyHasHeader() throws Exception {
        long activity = createActivity(15);
        for (int i = 0; i < 15; i++) register(activity, createUser("USER", "导出 " + i));
        start(activity, NOW);
        var first = admin.roster(activity, 1, 10, "ALL", "ALL", adminId());
        checkIns.checkIn(activity, first.items().getFirst().id(), adminId());
        String all = new String(admin.exportRoster(activity, "ALL", "ALL", adminId()), StandardCharsets.UTF_8);
        assertThat(all.lines().count()).isEqualTo(16);
        assertThat(all).contains("\"\t" + first.items().getFirst().id() + "\"");
        assertThat(new String(admin.exportRoster(activity, "ACTIVE", "NOT_CHECKED_IN", adminId()), StandardCharsets.UTF_8).lines().count()).isEqualTo(15);
        assertThat(new String(admin.exportRoster(activity, "ALL", "CHECKED_IN", adminId()), StandardCharsets.UTF_8).lines().count()).isEqualTo(2);
        byte[] empty = admin.exportRoster(activity, "WAITING", "ALL", adminId());
        assertThat(new String(empty, StandardCharsets.UTF_8).lines().count()).isEqualTo(1);
        var response = mvc.perform(get(exportPath(activity)).with(user(principal(adminId()))).param("page", "2").param("pageSize", "1"))
            .andExpect(status().isOk()).andExpect(content().contentType("text/csv;charset=UTF-8"))
            .andExpect(header().string("Content-Disposition", "attachment; filename=\"activity-" + activity + "-registrations.csv\""))
            .andExpect(header().string("Cache-Control", "no-store")).andReturn().getResponse();
        assertThat(response.getContentAsByteArray()).startsWith((byte) 0xEF, (byte) 0xBB, (byte) 0xBF);
        assertThat(new String(response.getContentAsByteArray(), StandardCharsets.UTF_8)).isEqualTo(all);
    }

    @Test
    void exportCountAndContentsShareSnapshotDuringConcurrentAttendanceCommit() {
        long activity = createActivity(1);
        long registration = register(activity, createUser("USER", "导出快照"));
        start(activity, NOW);
        hooks.hook.set(new Hook(AdminMapper.class.getName() + ".countRoster", false,
            () -> inOtherThread(() -> checkIns.checkIn(activity, registration, adminId()))));
        String csv = new String(admin.exportRoster(activity, "ALL", "NOT_CHECKED_IN", adminId()), StandardCharsets.UTF_8);
        assertThat(csv.lines().count()).isEqualTo(2);
        assertThat(csv).contains("\"未签到\"").doesNotContain("\"已签到\"");
        assertThat(new String(admin.exportRoster(activity, "ALL", "NOT_CHECKED_IN", adminId()), StandardCharsets.UTF_8).lines().count()).isEqualTo(1);
    }

    @Test
    void exactTwentyThousandRowLimitExportsCompletelyAndTwentyThousandOneIsExplicit413() throws Exception {
        long activity = createActivity(1);
        String prefix = "bulkci_" + UUID.randomUUID().toString().replace("-", "");
        String hash = users.findByUsername("demo").passwordHash();
        var values = new ArrayList<Object[]>();
        for (int i = 0; i < 20_000; i++) values.add(new Object[]{prefix + i, hash, "导出上限参与者", "USER"});
        new TransactionTemplate(transactions).executeWithoutResult(tx ->
            jdbc.batchUpdate("INSERT INTO users(username,password_hash,display_name,role) VALUES(?,?,?,?)", values, 500,
                (statement, value) -> { for (int i = 0; i < value.length; i++) statement.setObject(i + 1, value[i]); }));
        var bulkIds = jdbc.queryForList("SELECT id FROM users WHERE LEFT(username,CHAR_LENGTH(?))=? ORDER BY id", Long.class, prefix, prefix);
        userIds.addAll(bulkIds);
        assertThat(bulkIds).hasSize(20_000);
        jdbc.update("INSERT INTO registrations(activity_id,user_id,status) SELECT ?,id,'WAITING' FROM users WHERE LEFT(username,CHAR_LENGTH(?))=?", activity, prefix, prefix);
        String csv = new String(admin.exportRoster(activity, "WAITING", "ALL", adminId()), StandardCharsets.UTF_8);
        assertThat(csv.lines().count()).isEqualTo(20_001);
        assertThat(csv).contains("\"\t" + jdbc.queryForObject("SELECT MIN(id) FROM registrations WHERE activity_id=?", Long.class, activity) + "\"");
        register(activity, createUser("USER", "超过上限"));
        mvc.perform(get(exportPath(activity)).with(user(principal(adminId()))))
            .andExpect(status().is(413)).andExpect(jsonPath("$.code").value("EXPORT_TOO_LARGE"))
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON));
        assertThat(admin.exportRoster(activity, "ACTIVE", "ALL", adminId())).isNotEmpty();
    }

    @Test
    void newRoutesHaveFiniteLabelsAndDoNotLogQueryUserNamesOrCsvContents(CapturedOutput output) throws Exception {
        long activity = createActivity(1);
        String secret = "PRIVATE_CSV_" + UUID.randomUUID();
        long registration = register(activity, createUser("USER", secret));
        start(activity, NOW);
        for (String path : List.of(checkInPath(activity, registration), exportPath(activity))) {
            var response = (path.endsWith("check-in")
                ? mvc.perform(post(path).with(user(principal(adminId()))).with(csrf()).param("secret", secret))
                : mvc.perform(get(path).with(user(principal(adminId()))).param("secret", secret)))
                .andExpect(status().isOk()).andReturn().getResponse();
            String id = response.getHeader("X-Request-Id");
            String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(id) && value.contains("http_request"))
                .findFirst().orElseThrow();
            assertThat(json.readTree(line).get("route").asString()).isEqualTo(path.endsWith("check-in")
                ? "/api/admin/activities/{id}/registrations/{registrationId}/check-in" : "/api/admin/activities/{id}/registrations/export");
            assertThat(line).doesNotContain(secret).doesNotContain("签到管理员昵称");
        }
        for (String path : List.of(checkInPath(activity, registration), exportPath(activity))) {
            var response = (path.endsWith("check-in") ? mvc.perform(post(path)) : mvc.perform(get(path))).andReturn().getResponse();
            String id = response.getHeader("X-Request-Id");
            String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(id) && value.contains("http_request"))
                .findFirst().orElseThrow();
            assertThat(json.readTree(line).get("route").asString()).isNotEqualTo("/UNKNOWN");
        }
    }

    private long createActivity(int capacity) {
        long id = activities.create(new CreateActivityRequest("CheckIn " + UUID.randomUUID(), "签到验证", "本地测试", NOW.plusSeconds(3600), capacity), adminId()).id();
        activityIds.add(id); return id;
    }
    private long createUser(String role, String name) {
        String username = "checkin_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), name, role);
        long id = users.findByUsername(username).id(); userIds.add(id); return id;
    }
    private long register(long activity, long member) {
        registrations.register(activity, member);
        return jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activity, member);
    }
    private void start(long activity, Instant time) { jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(time), activity); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private long demoId() { return users.findByUsername("demo").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private List<Map<String, Object>> registrationRows(long activity) { return jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", activity); }
    private static String rosterPath(long activity) { return "/api/admin/activities/" + activity + "/registrations"; }
    private static String exportPath(long activity) { return rosterPath(activity) + "/export"; }
    private static String checkInPath(long activity, long registration) { return rosterPath(activity) + "/" + registration + "/check-in"; }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time, ZoneOffset.UTC); }
    private static void expectCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOf(ApiException.class).satisfies(error -> assertThat(((ApiException) error).code()).isEqualTo(code));
    }
    private static void await(CountDownLatch latch) {
        try { assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue(); }
        catch (InterruptedException exception) { Thread.currentThread().interrupt(); throw new IllegalStateException(exception); }
    }
    private static void inOtherThread(Runnable action) {
        try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(20, TimeUnit.SECONDS); }
        catch (Exception exception) { throw new IllegalStateException(exception); }
    }
}

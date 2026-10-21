package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.api.NotificationModels.*;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.NotificationMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.NotificationService;
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
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real InnoDB writes, constraints, concurrent transactions and per-fixture cleanup. */
@SpringBootTest
@AutoConfigureMockMvc
@Import(NotificationIntegrationTest.TestConfiguration.class)
@ExtendWith(OutputCaptureExtension.class)
class NotificationIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-07-01T09:00:00.123456Z");
    private static final String READ_ALL = "/api/me/notifications/read-all";

    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
    static class TestConfiguration {
        @Bean @Primary MutableClock notificationClock() { return new MutableClock(); }
        @Bean NotificationInterceptor notificationInterceptor() { return new NotificationInterceptor(); }
    }

    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return time.get(); }
    }

    record WriteFault(String method, boolean after, Runnable action) {}
    record Statement(String method, String sql, Object parameters, boolean readOnly, Integer isolation) {}

    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class NotificationInterceptor implements Interceptor {
        final AtomicReference<Runnable> afterUnreadCount = new AtomicReference<>();
        final AtomicReference<Runnable> afterUnreadIds = new AtomicReference<>();
        final AtomicReference<WriteFault> writeFault = new AtomicReference<>();
        final ThreadLocal<List<Statement>> captured = new ThreadLocal<>();
        final AtomicInteger bulkWrites = new AtomicInteger();
        final AtomicInteger failBulkWriteAt = new AtomicInteger();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            String id = statement.getId();
            if (captured.get() != null && id.startsWith(NotificationMapper.class.getName() + ".")) {
                captured.get().add(new Statement(id.substring(id.lastIndexOf('.') + 1),
                    statement.getBoundSql(invocation.getArgs()[1]).getSql(), invocation.getArgs()[1],
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                    TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            WriteFault fault = writeFault.get();
            if (fault != null && id.equals(NotificationMapper.class.getName() + "." + fault.method())
                && writeFault.compareAndSet(fault, null)) {
                if (!fault.after()) fault.action().run();
                Object value = invocation.proceed();
                if (fault.after()) fault.action().run();
                return value;
            }
            Object value = invocation.proceed();
            if (id.equals(NotificationMapper.class.getName() + ".markSelectedRead")
                && bulkWrites.incrementAndGet() == failBulkWriteAt.get()) {
                throw new DataAccessResourceFailureException("Injected bulk notification update failure");
            }
            if (id.equals(NotificationMapper.class.getName() + ".unreadCount")) {
                Runnable action = afterUnreadCount.getAndSet(null);
                if (action != null) action.run();
            }
            if (id.equals(NotificationMapper.class.getName() + ".unreadIds")) {
                Runnable action = afterUnreadIds.getAndSet(null);
                if (action != null) action.run();
            }
            return value;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !java.net.URI.create(url.substring("jdbc:".length())).getPath().equals("/activity_platform_test")) {
            throw new IllegalStateException("Notification tests require the dedicated REAL activity_platform_test MySQL database");
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
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityMapper activityMapper;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired NotificationService notifications;
    @Autowired PlatformTransactionManager transactions;
    @Autowired MutableClock clock;
    @Autowired NotificationInterceptor hooks;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanOwnedFixturesOnly() {
        hooks.afterUnreadCount.set(null);
        hooks.afterUnreadIds.set(null);
        hooks.writeFault.set(null);
        hooks.captured.remove();
        hooks.bulkWrites.set(0);
        hooks.failBulkWriteAt.set(0);
        clock.time.set(NOW);
        clock.calls.set(0);
        com.example.gather.support.OwnedIntegrationFixtures.remove(jdbc, activityIds, userIds);
    }

    @Test
    void notificationApisRequireAuthenticationCsrfAndTrustedOwnership() throws Exception {
        long activity = createActivity(1);
        long owner = createUser();
        long other = createUser();
        long notice = insertNotice(activity, owner, NOW, null);
        for (String path : List.of("/api/me/notifications", "/api/me/notifications/unread-count")) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
            mvc.perform(get(path).with(user(principal(other))).param("userId", Long.toString(owner)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.unreadCount").value(0));
        }
        mvc.perform(post(readPath(notice)).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(post(readPath(notice)).with(user(principal(owner))))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        for (long id : List.of(notice, Long.MAX_VALUE)) {
            mvc.perform(post(readPath(id)).with(user(principal(other))).with(csrf()).param("userId", Long.toString(owner))
                .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":" + owner + ",\"readAt\":\"2040-01-01T00:00:00Z\"}"))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("NOTIFICATION_NOT_FOUND"));
        }
        assertThat(notifications.page(owner, 1, 10, "UNREAD").items()).hasSize(1).allMatch(item -> item.readAt() == null);
        mvc.perform(post(readPath(notice)).with(user(principal(owner))).with(csrf()).param("userId", Long.toString(other)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(notice))
            .andExpect(jsonPath("$.createdAt").value(NOW.toString())).andExpect(jsonPath("$.readAt").value(NOW.toString()));
        long adminNotice = insertNotice(activity, adminId(), NOW, null);
        mvc.perform(post(readPath(adminNotice)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk());
        mvc.perform(get("/api/me/notifications").with(user(principal(adminId()))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].id").value(adminNotice));
    }

    @Test
    void malformedBlankAndOutOfRangeParametersReturnValidationError() throws Exception {
        long member = createUser();
        for (String[] pair : List.of(new String[]{"page", "0"}, new String[]{"page", "-1"}, new String[]{"page", ""},
            new String[]{"page", " 1"}, new String[]{"page", "1.5"}, new String[]{"page", "2147483648"},
            new String[]{"pageSize", "0"}, new String[]{"pageSize", "101"}, new String[]{"pageSize", ""},
            new String[]{"pageSize", "number"}, new String[]{"status", ""}, new String[]{"status", "unread"},
            new String[]{"status", "UNKNOWN"}, new String[]{"status", "ACTIVE"}, new String[]{"type", ""},
            new String[]{"type", "promoted"}, new String[]{"type", "UNKNOWN"}, new String[]{"type", "ALL "})) {
            mvc.perform(get("/api/me/notifications").with(user(principal(member))).param(pair[0], pair[1]))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        mvc.perform(get("/api/me/notifications").with(user(principal(member))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.page").value(1)).andExpect(jsonPath("$.pageSize").value(10));
        mvc.perform(get("/api/me/notifications/not-a-number/read").with(user(principal(member))))
            .andExpect(status().isMethodNotAllowed());
        mvc.perform(post("/api/me/notifications/not-a-number/read").with(user(principal(member))).with(csrf()))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    @Test
    void stablePaginationFiltersOwnRowsAndUnreadCountCoversAllPagesAndStatuses() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long other = createUser();
        List<Long> ids = new ArrayList<>();
        for (int i = 0; i < 13; i++) ids.add(insertNotice(activity, member, NOW, i < 3 ? NOW : null));
        insertNotice(activity, other, NOW.plusSeconds(1), null);
        var first = notifications.page(member, 1, 10, "ALL");
        var second = notifications.page(member, 2, 10, "ALL");
        assertThat(first.total()).isEqualTo(13);
        assertThat(first.unreadCount()).isEqualTo(10);
        assertThat(first.items()).extracting(NotificationView::id).containsExactlyElementsOf(ids.reversed().subList(0, 10));
        assertThat(second.items()).extracting(NotificationView::id).containsExactlyElementsOf(ids.reversed().subList(10, 13));
        assertThat(second.unreadCount()).isEqualTo(10);
        var unread = notifications.page(member, 1, 100, "UNREAD");
        assertThat(unread.total()).isEqualTo(10);
        assertThat(unread.items()).hasSize(10).allMatch(item -> item.readAt() == null);
        var read = notifications.page(member, 1, 100, "READ");
        assertThat(read.total()).isEqualTo(3);
        assertThat(read.unreadCount()).isEqualTo(10);
        assertThat(read.items()).hasSize(3).allMatch(item -> item.readAt() != null);
        mvc.perform(get("/api/me/notifications/unread-count").with(user(principal(member))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.unreadCount").value(10));
        assertThat(notifications.page(member, Integer.MAX_VALUE, 100, "ALL").items()).isEmpty();
        assertThat(notifications.page(member, Integer.MAX_VALUE, 100, "ALL").total()).isEqualTo(13);
        assertThat(notifications.page(createUser(), 1, 10, "ALL"))
            .isEqualTo(new NotificationPageView(List.of(), 0, 1, 10, 0));
    }

    @Test
    void typeAndStatusUseTheSameOwnedFilterWhileUnreadCountRemainsGlobal() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long other = createUser();
        for (int i = 0; i < 12; i++) insertNotice(activity, member,
            i % 2 == 0 ? "PROMOTED" : "ACTIVITY_CANCELLED", NOW, i < 4 ? NOW : null);
        insertNotice(activity, other, "ACTIVITY_CANCELLED", NOW.plusSeconds(1), null);
        var all = notifications.page(member, 1, 100, "ALL");
        assertThat(notifications.page(member, 1, 100, "ALL", "ALL")).isEqualTo(all);
        for (String type : List.of("ALL", "PROMOTED", "ACTIVITY_CANCELLED")) {
            for (String status : List.of("ALL", "UNREAD", "READ")) {
                var expected = all.items().stream().filter(item -> type.equals("ALL") || item.type().equals(type))
                    .filter(item -> status.equals("ALL") || status.equals(item.readAt() == null ? "UNREAD" : "READ")).toList();
                hooks.captured.set(new ArrayList<>());
                var page = notifications.page(member, 2, 2, status, type);
                var calls = hooks.captured.get();
                hooks.captured.remove();
                assertThat(page.total()).isEqualTo(expected.size());
                assertThat(page.unreadCount()).isEqualTo(8);
                assertThat(page.items()).containsExactlyElementsOf(expected.subList(Math.min(2, expected.size()), Math.min(4, expected.size())));
                assertThat(calls).extracting(Statement::method).containsExactly("unreadCount", "count", "page");
                assertThat(calls).allSatisfy(call -> {
                    assertThat(call.readOnly()).isTrue();
                    assertThat(call.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
                    assertThat(call.sql()).contains("user_id=?").doesNotContain("FOR UPDATE");
                });
                assertThat(calls.getFirst().sql()).doesNotContain("type=");
                for (var call : calls.subList(1, 3)) {
                    assertThat(parameters(call)).containsEntry("userId", member).containsEntry("status", status).containsEntry("type", type);
                    if (!type.equals("ALL")) assertThat(call.sql()).contains("type=?");
                    if (status.equals("READ")) assertThat(call.sql()).contains("read_at IS NOT NULL");
                    if (status.equals("UNREAD")) assertThat(call.sql()).contains("read_at IS NULL");
                }
            }
        }
        mvc.perform(get("/api/me/notifications").with(user(principal(member))).param("type", "ACTIVITY_CANCELLED")
            .param("status", "UNREAD").param("pageSize", "2").param("page", "2").param("userId", Long.toString(other)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(4))
            .andExpect(jsonPath("$.unreadCount").value(8)).andExpect(jsonPath("$.items.length()").value(2))
            .andExpect(jsonPath("$.items[0].type").value("ACTIVITY_CANCELLED"));
        mvc.perform(get("/api/me/notifications").param("type", "PROMOTED")).andExpect(status().isUnauthorized());
    }

    @Test
    void bulkReadRequiresCsrfAndUsesOnlyTrustedOwnerAcrossEveryPageAndType() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long other = createUser();
        long alreadyRead = insertNotice(activity, member, NOW.minusSeconds(10), NOW.minusSeconds(5));
        for (int i = 0; i < 13; i++) insertNotice(activity, member,
            i % 2 == 0 ? "PROMOTED" : "ACTIVITY_CANCELLED", NOW, null);
        long otherNotice = insertNotice(activity, other, NOW, null);
        var businessBefore = jdbc.queryForMap("SELECT registered_count, cancelled_at FROM activities WHERE id=?", activity);
        var registrationsBefore = registrationsRows(activity);
        var auditBefore = jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", activity);
        mvc.perform(post(READ_ALL).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(post(READ_ALL).with(user(principal(member))))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(post(READ_ALL).with(user(principal(member))).with(csrf().useInvalidToken()))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(notifications.unreadCount(member).unreadCount()).isEqualTo(13);
        mvc.perform(post(READ_ALL).with(user(principal(member))).with(csrf()).param("userId", Long.toString(other))
            .param("type", "PROMOTED").param("status", "READ").param("page", "2")
            .contentType(MediaType.APPLICATION_JSON).content("{\"userId\":" + other + ",\"readAt\":\"2040-01-01T00:00:00Z\"}"))
            .andExpect(status().isOk()).andExpect(content().json("{\"updatedCount\":13}"));
        assertThat(notifications.unreadCount(member).unreadCount()).isZero();
        assertThat(notifications.page(member, 1, 100, "ALL").items()).hasSize(14).allSatisfy(item ->
            assertThat(item.readAt()).isEqualTo(item.id() == alreadyRead ? NOW.minusSeconds(5) : NOW));
        assertThat(notifications.page(other, 1, 100, "UNREAD").items()).extracting(NotificationView::id).containsExactly(otherNotice);
        clock.time.set(NOW.plusSeconds(30));
        mvc.perform(post(READ_ALL).with(user(principal(member))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.updatedCount").value(0));
        assertThat(notifications.page(member, 1, 100, "ALL").items()).allSatisfy(item ->
            assertThat(item.readAt()).isEqualTo(item.id() == alreadyRead ? NOW.minusSeconds(5) : NOW));
        assertThat(jdbc.queryForMap("SELECT registered_count, cancelled_at FROM activities WHERE id=?", activity)).isEqualTo(businessBefore);
        assertThat(registrationsRows(activity)).isEqualTo(registrationsBefore);
        assertThat(jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", activity)).isEqualTo(auditBefore);
        long isolatedAdmin = createUser("ADMIN");
        insertNotice(activity, isolatedAdmin, NOW, null);
        mvc.perform(post(READ_ALL).with(user(principal(isolatedAdmin))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.updatedCount").value(1));
        assertThat(notifications.unreadCount(other).unreadCount()).isEqualTo(1);
    }

    @Test
    void emptyBulkSelectionDoesNotUpdateAndUsesReadCommittedWithoutRowLocks() {
        long member = createUser();
        hooks.captured.set(new ArrayList<>());
        assertThat(notifications.markAllRead(member).updatedCount()).isZero();
        var calls = hooks.captured.get();
        hooks.captured.remove();
        assertThat(calls).hasSize(1).allSatisfy(call -> {
            assertThat(call.method()).isEqualTo("unreadIds");
            assertThat(call.readOnly()).isFalse();
            assertThat(call.isolation()).isEqualTo(TransactionDefinition.ISOLATION_READ_COMMITTED);
            assertThat(call.sql()).contains("user_id=?", "read_at IS NULL", "ORDER BY id ASC").doesNotContain("FOR UPDATE", "MAX(");
            assertThat(parameters(call)).containsEntry("userId", member);
        });
    }

    @Test
    void bulkCaptureExcludesLaterNotificationsEvenWithSameOrEarlierCreatedTime() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long first = insertNotice(activity, member, NOW, null);
        long future = insertNotice(activity, member, "ACTIVITY_CANCELLED", NOW.plusSeconds(5), null);
        try (var writer = Executors.newSingleThreadExecutor()) {
            hooks.afterUnreadIds.set(() -> await(writer.submit(() -> {
                insertNotice(activity, member, NOW, null);
                insertNotice(activity, member, "ACTIVITY_CANCELLED", NOW.minusSeconds(1), null);
            })));
            clock.time.set(NOW.plusNanos(789));
            clock.calls.set(0);
            assertThat(notifications.markAllRead(member).updatedCount()).isEqualTo(2);
            assertThat(clock.calls.get()).isEqualTo(1);
            assertThat(hooks.afterUnreadIds.get()).isNull();
        }
        assertThat(notifications.page(member, 1, 100, "UNREAD").items()).hasSize(2)
            .noneMatch(item -> item.id() == first || item.id() == future);
        assertThat(notifications.page(member, 1, 100, "READ").items()).hasSize(2).allSatisfy(item ->
            assertThat(item.readAt()).isEqualTo(item.id() == future ? NOW.plusSeconds(5) : NOW));
        assertThat(notifications.markAllRead(member).updatedCount()).isEqualTo(2);
    }

    @Test
    void lowerIdInsertCommittedAfterCaptureRemainsUnread() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        var inserted = new CountDownLatch(1);
        var releaseCommit = new CountDownLatch(1);
        var transaction = new TransactionTemplate(transactions);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        try (var writer = Executors.newSingleThreadExecutor()) {
            var pending = writer.submit(() -> transaction.execute(status -> {
                long id = insertNotice(activity, member, NOW.minusSeconds(10), null);
                inserted.countDown();
                await(releaseCommit);
                return id;
            }));
            try {
                assertThat(inserted.await(10, TimeUnit.SECONDS)).isTrue();
                long high = insertNotice(activity, member, NOW, null);
                hooks.afterUnreadIds.set(() -> { releaseCommit.countDown(); await(pending); });
                assertThat(notifications.markAllRead(member).updatedCount()).isEqualTo(1);
                long low = pending.get(10, TimeUnit.SECONDS);
                assertThat(low).isLessThan(high);
                assertThat(notifications.page(member, 1, 100, "UNREAD").items()).extracting(NotificationView::id).containsExactly(low);
                assertThat(notifications.page(member, 1, 100, "READ").items()).extracting(NotificationView::id).containsExactly(high);
            } finally {
                releaseCommit.countDown();
            }
        }
    }

    @Test
    void singleReadDuringBulkCaptureKeepsItsFirstTimestampAndIsNotCountedAgain() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long first = insertNotice(activity, member, NOW, null);
        for (int i = 0; i < 4; i++) insertNotice(activity, member, NOW, null);
        clock.time.set(NOW.plusSeconds(1));
        try (var reader = Executors.newSingleThreadExecutor()) {
            hooks.afterUnreadIds.set(() -> {
                assertThat(await(reader.submit(() -> notifications.markRead(first, member))).readAt()).isEqualTo(NOW.plusSeconds(1));
                clock.time.set(NOW.plusSeconds(2));
            });
            assertThat(notifications.markAllRead(member).updatedCount()).isEqualTo(4);
        }
        assertThat(notifications.page(member, 1, 100, "READ").items()).hasSize(5).allSatisfy(item ->
            assertThat(item.readAt()).isEqualTo(NOW.plusSeconds(item.id() == first ? 1 : 2)));
    }

    @Test
    void concurrentBulkRequestsDoNotDoubleCountOrDeadlock() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        insertNotices(activity, member, 32);
        var start = new CountDownLatch(1);
        try (var readers = Executors.newVirtualThreadPerTaskExecutor()) {
            var results = new ArrayList<java.util.concurrent.Future<MarkAllReadView>>();
            for (int i = 0; i < 8; i++) results.add(readers.submit(() -> {
                await(start);
                return notifications.markAllRead(member);
            }));
            start.countDown();
            long updated = 0;
            for (var result : results) updated += result.get(20, TimeUnit.SECONDS).updatedCount();
            assertThat(updated).isEqualTo(32);
        }
        assertThat(notifications.unreadCount(member).unreadCount()).isZero();
        assertThat(notifications.page(member, 1, 100, "READ").items()).hasSize(32).allSatisfy(item -> assertThat(item.readAt()).isEqualTo(NOW));
    }

    @Test
    void overlappingBulkSelectionsKeepPrimaryKeyLockOrderAcrossBatchBoundaries() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        var inserted = new CountDownLatch(1);
        var releaseInsert = new CountDownLatch(1);
        var capturedFirst = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        var secondUpdatedFirstBatch = new CountDownLatch(1);
        var releaseSecond = new CountDownLatch(1);
        var firstUpdateAttempted = new CountDownLatch(1);
        var transaction = new TransactionTemplate(transactions);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        try (var workers = Executors.newFixedThreadPool(3)) {
            var pending = workers.submit(() -> transaction.execute(status -> {
                long id = insertNotice(activity, member, NOW.minusSeconds(10), null);
                inserted.countDown();
                await(releaseInsert);
                return id;
            }));
            try {
                await(inserted);
                insertNotices(activity, member, 1001);
                hooks.afterUnreadIds.set(() -> { capturedFirst.countDown(); await(releaseFirst); });
                var first = workers.submit(() -> notifications.markAllRead(member));
                await(capturedFirst);
                releaseInsert.countDown();
                await(pending);
                hooks.writeFault.set(new WriteFault("markSelectedRead", true, () -> {
                    secondUpdatedFirstBatch.countDown();
                    await(releaseSecond);
                }));
                var second = workers.submit(() -> notifications.markAllRead(member));
                await(secondUpdatedFirstBatch);
                hooks.writeFault.set(new WriteFault("markSelectedRead", false, firstUpdateAttempted::countDown));
                releaseFirst.countDown();
                await(firstUpdateAttempted);
                // The first request must wait at its lowest selected primary key until the second commits.
                assertThatThrownBy(() -> first.get(200, TimeUnit.MILLISECONDS)).isInstanceOf(java.util.concurrent.TimeoutException.class);
                releaseSecond.countDown();
                assertThat(second.get(20, TimeUnit.SECONDS).updatedCount()).isEqualTo(1002);
                assertThat(first.get(20, TimeUnit.SECONDS).updatedCount()).isZero();
                assertThat(notifications.unreadCount(member).unreadCount()).isZero();
            } finally {
                releaseInsert.countDown();
                releaseFirst.countDown();
                releaseSecond.countDown();
            }
        }
    }

    @Test
    void thousandAndOneRowsUseTwoOwnedOrderedBatchesAndSecondFailureRollsEverythingBack() {
        long activity = createActivity(1);
        long member = createUser();
        long other = createUser();
        insertNotices(activity, member, 1001);
        insertNotice(activity, other, NOW, null);
        var expectedIds = jdbc.queryForList("SELECT id FROM notifications WHERE user_id=? ORDER BY id", Long.class, member);
        hooks.failBulkWriteAt.set(2);
        hooks.captured.set(new ArrayList<>());
        clock.calls.set(0);
        assertThatThrownBy(() -> notifications.markAllRead(member)).isInstanceOf(DataAccessException.class);
        assertThat(clock.calls.get()).isEqualTo(1);
        var calls = hooks.captured.get();
        hooks.captured.remove();
        assertThat(calls).extracting(Statement::method).containsExactly("unreadIds", "markSelectedRead", "markSelectedRead");
        assertThat(calls).allSatisfy(call -> {
            assertThat(call.isolation()).isEqualTo(TransactionDefinition.ISOLATION_READ_COMMITTED);
            assertThat(call.readOnly()).isFalse();
            assertThat(parameters(call)).containsEntry("userId", member);
        });
        for (int i = 1; i <= 2; i++) {
            var call = calls.get(i);
            assertThat(call.sql()).contains("FORCE INDEX (PRIMARY)", "GREATEST(created_at, ?)", "user_id=?", "read_at IS NULL", "id IN", "ORDER BY id ASC");
            assertThat(selectedIds(call))
                .containsExactlyElementsOf(expectedIds.subList((i - 1) * 1000, Math.min(i * 1000, 1001)));
        }
        assertThat(notifications.unreadCount(member).unreadCount()).isEqualTo(1001);
        assertThat(notifications.page(member, 1, 1, "READ").total()).isZero();
        hooks.failBulkWriteAt.set(0);
        hooks.bulkWrites.set(0);
        clock.time.set(NOW.plusSeconds(2).plusNanos(999));
        clock.calls.set(0);
        assertThat(notifications.markAllRead(member).updatedCount()).isEqualTo(1001);
        assertThat(hooks.bulkWrites.get()).isEqualTo(2);
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at=?", Long.class, member, utc(NOW.plusSeconds(2))))
            .isEqualTo(1001);
        assertThat(notifications.unreadCount(other).unreadCount()).isEqualTo(1);
    }

    @Test
    void markReadIsConcurrentIdempotentAndKeepsItsFirstMicrosecondTimestamp() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long notice = insertNotice(activity, member, NOW, null);
        clock.time.set(NOW.plusSeconds(1).plusNanos(789));
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            var start = new CountDownLatch(1);
            var results = new ArrayList<java.util.concurrent.Future<NotificationView>>();
            for (int i = 0; i < 20; i++) results.add(pool.submit(() -> {
                assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                return notifications.markRead(notice, member);
            }));
            start.countDown();
            for (var result : results) assertThat(result.get(20, TimeUnit.SECONDS).readAt())
                .isEqualTo(NOW.plusSeconds(1));
        }
        clock.time.set(NOW.plusSeconds(100));
        assertThat(notifications.markRead(notice, member).readAt()).isEqualTo(NOW.plusSeconds(1));
        assertThat(notifications.unreadCount(member).unreadCount()).isZero();
        long futureNotice = insertNotice(activity, member, NOW.plusSeconds(200), null);
        assertThat(notifications.markRead(futureNotice, member).readAt()).isEqualTo(NOW.plusSeconds(200));
    }

    @Test
    void repeatableReadKeepsUnreadCountTotalAndItemsOnTheSameCommittedSnapshot() throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long first = insertNotice(activity, member, NOW, null);
        try (var writer = Executors.newSingleThreadExecutor()) {
            hooks.afterUnreadCount.set(() -> {
                try {
                    writer.submit(() -> {
                        notifications.markRead(first, member);
                        insertNotice(activity, member, NOW.plusSeconds(1), null);
                    }).get(10, TimeUnit.SECONDS);
                } catch (Exception exception) {
                    throw new AssertionError("Writer must commit between aggregate and page reads", exception);
                }
            });
            var page = notifications.page(member, 1, 10, "UNREAD", "PROMOTED");
            assertThat(hooks.afterUnreadCount.get()).isNull();
            assertThat(page.unreadCount()).isEqualTo(1);
            assertThat(page.total()).isEqualTo(1);
            assertThat(page.items()).hasSize(1).allSatisfy(item -> {
                assertThat(item.id()).isEqualTo(first);
                assertThat(item.readAt()).isNull();
            });
        }
        var next = notifications.page(member, 1, 10, "ALL");
        assertThat(next.total()).isEqualTo(2);
        assertThat(next.unreadCount()).isEqualTo(1);
        assertThat(next.items().get(1).readAt()).isNotNull();
    }

    @Test
    void constraintsKeepValidSnapshotsTimesAndRestrictiveHistoryForeignKeys() {
        long activity = createActivity(1);
        long member = createUser();
        long notice = insertNotice(activity, member, NOW, null);
        for (String sql : List.of("UPDATE notifications SET type='UNKNOWN' WHERE id=?",
            "UPDATE notifications SET activity_title=' ' WHERE id=?",
            "UPDATE notifications SET cancellation_reason='extra' WHERE id=?",
            "UPDATE notifications SET type='ACTIVITY_CANCELLED' WHERE id=?")) {
            assertThatThrownBy(() -> jdbc.update(sql, notice)).isInstanceOf(DataAccessException.class);
        }
        assertThatThrownBy(() -> jdbc.update("UPDATE notifications SET read_at=? WHERE id=?", utc(NOW.minusNanos(1000)), notice))
            .isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM users WHERE id=?", member)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM activities WHERE id=?", activity)).isInstanceOf(DataAccessException.class);
        assertThat(notifications.page(member, 1, 10, "ALL").items()).hasSize(1).allMatch(item -> item.readAt() == null);
    }

    @Test
    void eventWritersCannotCommitWithoutTheBusinessTransaction() {
        long activity = createActivity(1);
        long member = createUser();
        assertThatThrownBy(() -> notifications.promoted(activity, member)).isInstanceOf(IllegalTransactionStateException.class);
        assertThatThrownBy(() -> notifications.activityCancelled(activity, "原因", utc(NOW)))
            .isInstanceOf(IllegalTransactionStateException.class);
        assertThat(notificationRows(activity)).isEmpty();
    }

    @Test
    void onlyActualFifoPromotionNotifiesAndTitleRemainsAnEventSnapshot() {
        long activity = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        long later = createUser();
        long withdrawn = createUser();
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        registrations.register(activity, later);
        registrations.register(activity, withdrawn);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=?", utc(NOW), activity);
        registrations.cancel(activity, withdrawn);
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        assertThat(notificationRows(activity)).isEmpty();
        String title = "递补前的标题";
        activities.edit(activity, new EditActivityRequest(title, "说明", "地点"), adminId());
        registrations.cancel(activity, active);
        registrations.cancel(activity, active);
        var page = notifications.page(waiting, 1, 10, "ALL");
        assertThat(page.items()).hasSize(1).allSatisfy(item -> {
            assertThat(item.type()).isEqualTo("PROMOTED");
            assertThat(item.activityId()).isEqualTo(activity);
            assertThat(item.activityTitle()).isEqualTo(title);
            assertThat(item.cancellationReason()).isNull();
            assertThat(item.createdAt()).isNotNull();
            assertThat(item.readAt()).isNull();
        });
        activities.edit(activity, new EditActivityRequest("稍后的标题", "说明", "地点"), adminId());
        assertThat(notifications.page(waiting, 1, 10, "ALL").items().getFirst().activityTitle()).isEqualTo(title);
        assertThat(notifications.unreadCount(active).unreadCount()).isZero();
        assertThat(notifications.unreadCount(later).unreadCount()).isZero();
        assertThat(notifications.unreadCount(withdrawn).unreadCount()).isZero();
        assertInvariant(activity, 1, 1);
    }

    @Test
    void cancellingRejoiningAndBeingPromotedAgainProducesANewUnreadEvent() {
        long activity = createActivity(1);
        long first = createUser();
        long second = createUser();
        registrations.register(activity, first);
        registrations.register(activity, second);
        long registrationId = jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activity, second);
        registrations.cancel(activity, first);
        long firstNotice = notifications.page(second, 1, 10, "ALL").items().getFirst().id();
        notifications.markRead(firstNotice, second);
        registrations.register(activity, first);
        registrations.cancel(activity, second);
        registrations.register(activity, second);
        registrations.cancel(activity, first);
        var notices = notifications.page(second, 1, 10, "ALL");
        assertThat(notices.total()).isEqualTo(2);
        assertThat(notices.unreadCount()).isEqualTo(1);
        assertThat(notices.items()).extracting(NotificationView::type).containsOnly("PROMOTED");
        assertThat(notices.items().getFirst().id()).isNotEqualTo(firstNotice);
        assertThat(notices.items().getFirst().readAt()).isNull();
        assertThat(notices.items().getLast().readAt()).isNotNull();
        assertThat(jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activity, second))
            .isEqualTo(registrationId);
        assertInvariant(activity, 1, 0);
    }

    @Test
    void cancellationNotifiesExactlyCurrentActiveAndWaitingWithFirstReasonTimeAndTitle() {
        long activity = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        long withdrawn = createUser();
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        registrations.register(activity, withdrawn);
        registrations.cancel(activity, withdrawn);
        String title = activities.get(activity, null).title();
        activities.cancel(activity, new CancelActivityRequest("  场地临时关闭  "), adminId());
        var firstRows = notificationRows(activity);
        assertThat(firstRows).hasSize(2).extracting(row -> ((Number) row.get("user_id")).longValue()).containsExactlyInAnyOrder(active, waiting);
        for (long member : List.of(active, waiting)) {
            assertThat(notifications.page(member, 1, 10, "ALL").items()).hasSize(1).allSatisfy(item -> {
                assertThat(item.type()).isEqualTo("ACTIVITY_CANCELLED");
                assertThat(item.activityTitle()).isEqualTo(title);
                assertThat(item.cancellationReason()).isEqualTo("场地临时关闭");
                assertThat(item.createdAt()).isEqualTo(NOW);
                assertThat(item.readAt()).isNull();
            });
        }
        assertThat(notifications.unreadCount(withdrawn).unreadCount()).isZero();
        clock.time.set(NOW.plusSeconds(7200));
        activities.cancel(activity, new CancelActivityRequest("第二次原因"), adminId());
        assertThat(notificationRows(activity)).isEqualTo(firstRows);
        assertInvariant(activity, 0, 0);
        clock.time.set(NOW);
        long empty = createActivity(1);
        activities.cancel(empty, new CancelActivityRequest("没有报名"), adminId());
        assertThat(notificationRows(empty)).isEmpty();
    }

    @Test
    void concurrentDuplicateActivityCancellationCreatesOneNoticePerRecipient() throws Exception {
        long activity = createActivity(1);
        List<Long> recipients = List.of(createUser(), createUser(), createUser());
        for (long member : recipients) registrations.register(activity, member);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            var ready = new CountDownLatch(1);
            var results = new ArrayList<java.util.concurrent.Future<ActivityView>>();
            for (int i = 0; i < 12; i++) {
                int attempt = i;
                results.add(pool.submit(() -> {
                    assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                    return activities.cancel(activity, new CancelActivityRequest("并发原因" + attempt), adminId());
                }));
            }
            ready.countDown();
            ActivityView first = results.getFirst().get(20, TimeUnit.SECONDS);
            for (var result : results) assertThat(result.get(20, TimeUnit.SECONDS)).isEqualTo(first);
            assertThat(notificationRows(activity)).hasSize(3)
                .allMatch(row -> row.get("cancellation_reason").equals(first.cancellationReason()));
        }
        for (long member : recipients) assertThat(notifications.page(member, 1, 10, "ALL").total()).isEqualTo(1);
        assertInvariant(activity, 0, 0);
    }

    @Test
    void concurrentDuplicateUserCancellationPromotesAndNotifiesOnlyOnce() throws Exception {
        long activity = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            var ready = new CountDownLatch(1);
            var results = new ArrayList<java.util.concurrent.Future<?>>();
            for (int i = 0; i < 12; i++) results.add(pool.submit(() -> {
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                return registrations.cancel(activity, active);
            }));
            ready.countDown();
            for (var result : results) result.get(20, TimeUnit.SECONDS);
        }
        assertThat(notificationRows(activity)).hasSize(1);
        assertThat(notifications.page(waiting, 1, 10, "ALL").items()).hasSize(1).allMatch(item -> item.type().equals("PROMOTED"));
        assertInvariant(activity, 1, 0);
    }

    @Test
    void realMysqlNotificationInsertFailureRollsBackPromotionAndOriginalCancellation() {
        long activity = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        var before = registrationsRows(activity);
        hooks.writeFault.set(new WriteFault("insertPromotion", false, () -> invalidNotificationInsert(activity)));
        assertThatThrownBy(() -> registrations.cancel(activity, active)).isInstanceOf(DataAccessException.class);
        assertThat(hooks.writeFault.get()).isNull();
        assertThat(registrationsRows(activity)).isEqualTo(before);
        assertThat(notificationRows(activity)).isEmpty();
        assertInvariant(activity, 1, 1);
    }

    @Test
    void realMysqlFailureAfterPromotionInsertRollsBackAlreadyWrittenNoticeAndBusinessChanges() {
        long activity = createActivity(1);
        long active = createUser();
        long waiting = createUser();
        registrations.register(activity, active);
        registrations.register(activity, waiting);
        var before = registrationsRows(activity);
        hooks.writeFault.set(new WriteFault("insertPromotion", true,
            () -> jdbc.update("UPDATE activities SET registered_count=-1 WHERE id=?", activity)));
        assertThatThrownBy(() -> registrations.cancel(activity, active)).isInstanceOf(DataAccessException.class);
        assertThat(hooks.writeFault.get()).isNull();
        assertThat(registrationsRows(activity)).isEqualTo(before);
        assertThat(notificationRows(activity)).isEmpty();
        assertInvariant(activity, 1, 1);
    }

    @Test
    void realMysqlNotificationInsertFailureRollsBackWholeActivityCancellation() {
        long activity = createActivity(1);
        registrations.register(activity, createUser());
        registrations.register(activity, createUser());
        var before = activities.get(activity, null);
        var registrationBefore = registrationsRows(activity);
        hooks.writeFault.set(new WriteFault("insertCancellation", false, () -> invalidNotificationInsert(activity)));
        assertThatThrownBy(() -> activities.cancel(activity, new CancelActivityRequest("原因"), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(hooks.writeFault.get()).isNull();
        assertThat(activities.get(activity, null)).isEqualTo(before);
        assertThat(registrationsRows(activity)).isEqualTo(registrationBefore);
        assertThat(notificationRows(activity)).isEmpty();
        assertInvariant(activity, 1, 1);
    }

    @Test
    void laterActivityUpdateFailureRollsBackCancellationNotificationsAndRecipients() {
        long activity = createActivity(1);
        registrations.register(activity, createUser());
        registrations.register(activity, createUser());
        var before = activities.get(activity, null);
        var registrationBefore = registrationsRows(activity);
        assertThatThrownBy(() -> activities.cancel(activity, new CancelActivityRequest("原因"), Long.MAX_VALUE))
            .isInstanceOf(DataAccessException.class);
        assertThat(activities.get(activity, null)).isEqualTo(before);
        assertThat(registrationsRows(activity)).isEqualTo(registrationBefore);
        assertThat(notificationRows(activity)).isEmpty();
        assertInvariant(activity, 1, 1);
    }

    @Test
    void signupAndActivityCancellationUseTheSameLockForExactRecipientSelectionInBothOrders() throws Exception {
        long member = createUser();
        long signupFirst = createActivity(1);
        ordered(signupFirst, () -> registrations.register(signupFirst, member),
            () -> activities.cancel(signupFirst, new CancelActivityRequest("原因"), adminId()));
        assertThat(notifications.page(member, 1, 10, "ALL").items()).hasSize(1)
            .allMatch(item -> item.activityId() == signupFirst && item.type().equals("ACTIVITY_CANCELLED"));
        assertInvariant(signupFirst, 0, 0);
        long cancelFirst = createActivity(1);
        ordered(cancelFirst, () -> activities.cancel(cancelFirst, new CancelActivityRequest("原因"), adminId()),
            () -> expectCancelled(() -> registrations.register(cancelFirst, member)));
        assertThat(notificationRows(cancelFirst)).isEmpty();
        assertThat(registrationsRows(cancelFirst)).isEmpty();
        assertInvariant(cancelFirst, 0, 0);
    }

    @Test
    void userCancellationAndActivityCancellationProduceOnlyRealEventsInBothLockOrders() throws Exception {
        for (boolean adminFirst : List.of(false, true)) {
            long activity = createActivity(1);
            long active = createUser();
            long waiting = createUser();
            registrations.register(activity, active);
            registrations.register(activity, waiting);
            if (adminFirst) {
                ordered(activity, () -> activities.cancel(activity, new CancelActivityRequest("原因"), adminId()),
                    () -> expectCancelled(() -> registrations.cancel(activity, active)));
                assertThat(notifications.page(active, 1, 10, "ALL").items()).hasSize(1)
                    .allMatch(item -> item.type().equals("ACTIVITY_CANCELLED"));
                assertThat(notifications.page(waiting, 1, 10, "ALL").items()).hasSize(1)
                    .allMatch(item -> item.type().equals("ACTIVITY_CANCELLED"));
            } else {
                ordered(activity, () -> registrations.cancel(activity, active),
                    () -> activities.cancel(activity, new CancelActivityRequest("原因"), adminId()));
                assertThat(notifications.page(active, 1, 10, "ALL").items()).isEmpty();
                assertThat(notifications.page(waiting, 1, 10, "ALL").items()).hasSize(2)
                    .extracting(NotificationView::type).containsExactlyInAnyOrder("PROMOTED", "ACTIVITY_CANCELLED");
            }
            assertThat(notificationRows(activity)).hasSize(2);
            assertInvariant(activity, 0, 0);
        }
    }

    @Test
    void editingAndCancellationUseTheSameLockForTheTitleSnapshotInBothOrders() throws Exception {
        for (boolean cancelFirst : List.of(false, true)) {
            long activity = createActivity(1);
            long member = createUser();
            registrations.register(activity, member);
            String original = activities.get(activity, null).title();
            EditActivityRequest edit = new EditActivityRequest("取消前的最终标题", "说明", "地点");
            if (cancelFirst) ordered(activity, () -> activities.cancel(activity, new CancelActivityRequest("原因"), adminId()),
                () -> expectCancelled(() -> activities.edit(activity, edit, adminId())));
            else ordered(activity, () -> activities.edit(activity, edit, adminId()),
                () -> activities.cancel(activity, new CancelActivityRequest("原因"), adminId()));
            assertThat(notifications.page(member, 1, 10, "ALL").items()).hasSize(1)
                .allMatch(item -> item.activityTitle().equals(cancelFirst ? original : edit.title()));
            assertInvariant(activity, 0, 0);
        }
    }

    @Test
    void notificationRoutesStayFiniteAndDoNotLogQueryOrSnapshotContents(CapturedOutput output) throws Exception {
        long activity = createActivity(1);
        long member = createUser();
        long notice = insertNotice(activity, member, NOW, null);
        String secret = "PRIVATE_NOTICE_" + UUID.randomUUID();
        for (String path : List.of("/api/me/notifications", "/api/me/notifications/unread-count", readPath(notice), READ_ALL)) {
            var result = (path.endsWith("/read") || path.equals(READ_ALL)
                ? mvc.perform(post(path).with(user(principal(member))).with(csrf()).param("userId", secret))
                : mvc.perform(get(path).with(user(principal(member))).param("userId", secret)))
                .andExpect(status().isOk()).andReturn();
            String requestId = result.getResponse().getHeader("X-Request-Id");
            String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(requestId)
                && value.contains("http_request")).findFirst().orElseThrow();
            assertThat(json.readTree(line).get("route").asString())
                .isEqualTo(path.endsWith("/read") ? "/api/me/notifications/{id}/read" : path);
            assertThat(line).doesNotContain(secret).doesNotContain("Fixture notification");
        }
        for (String path : List.of(readPath(notice), READ_ALL)) {
            var rejected = mvc.perform(post(path).param("type", secret)).andExpect(status().isForbidden()).andReturn();
            String requestId = rejected.getResponse().getHeader("X-Request-Id");
            String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(requestId)
                && value.contains("http_request")).findFirst().orElseThrow();
            assertThat(json.readTree(line).get("route").asString())
                .isEqualTo(path.equals(READ_ALL) ? READ_ALL : "/api/me/notifications/{id}/read");
            assertThat(line).doesNotContain(secret).doesNotContain("Fixture notification");
        }
    }

    private long createActivity(int capacity) {
        long id = activities.create(new CreateActivityRequest("Notification " + UUID.randomUUID(), "Notification fixture", "Test venue",
            NOW.plusSeconds(3600), capacity), adminId()).id();
        activityIds.add(id);
        return id;
    }

    private long createUser() {
        return createUser("USER");
    }

    private long createUser(String role) {
        String username = "notice_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Notification fixture", role);
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private long insertNotice(long activity, long member, Instant createdAt, Instant readAt) {
        return insertNotice(activity, member, "PROMOTED", createdAt, readAt);
    }

    private long insertNotice(long activity, long member, String type, Instant createdAt, Instant readAt) {
        jdbc.update("INSERT INTO notifications(user_id, activity_id, type, activity_title, cancellation_reason, created_at, read_at) "
            + "VALUES(?, ?, ?, 'Fixture notification', ?, ?, ?)", member, activity, type,
            type.equals("ACTIVITY_CANCELLED") ? "Fixture cancellation reason" : null,
            utc(createdAt), readAt == null ? null : utc(readAt));
        return jdbc.queryForObject("SELECT MAX(id) FROM notifications WHERE activity_id=? AND user_id=?", Long.class, activity, member);
    }

    private void insertNotices(long activity, long member, int count) {
        new TransactionTemplate(transactions).executeWithoutResult(status -> jdbc.batchUpdate(
            "INSERT INTO notifications(user_id, activity_id, type, activity_title, cancellation_reason, created_at) "
            + "VALUES(?, ?, ?, 'Fixture notification', ?, ?)", java.util.stream.IntStream.range(0, count).boxed().toList(), 1000, (statement, i) -> {
                statement.setLong(1, member);
                statement.setLong(2, activity);
                statement.setString(3, i % 2 == 0 ? "PROMOTED" : "ACTIVITY_CANCELLED");
                statement.setString(4, i % 2 == 0 ? null : "Fixture cancellation reason");
                statement.setObject(5, utc(NOW.minusSeconds(i % 7)));
            }));
    }

    private static <T> T await(java.util.concurrent.Future<T> task) {
        try { return task.get(10, TimeUnit.SECONDS); }
        catch (Exception exception) { throw new AssertionError("Concurrent notification operation must finish", exception); }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parameters(Statement call) { return (Map<String, Object>) call.parameters(); }

    @SuppressWarnings("unchecked")
    private static List<Long> selectedIds(Statement call) { return (List<Long>) parameters(call).get("ids"); }

    private static void await(CountDownLatch latch) {
        try { assertThat(latch.await(10, TimeUnit.SECONDS)).isTrue(); }
        catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Concurrent notification latch interrupted", exception);
        }
    }

    private void invalidNotificationInsert(long activity) {
        jdbc.update("INSERT INTO notifications(user_id, activity_id, type, activity_title, created_at) VALUES(?, ?, 'PROMOTED', 'Failed fixture', ?)",
            Long.MAX_VALUE, activity, utc(NOW));
    }

    private void assertInvariant(long activity, int active, int waiting) {
        assertThat(jdbc.queryForObject("SELECT registered_count FROM activities WHERE id=?", Integer.class, activity)).isEqualTo(active);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status='ACTIVE'", Integer.class, activity)).isEqualTo(active);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status='WAITING'", Integer.class, activity)).isEqualTo(waiting);
    }

    private void ordered(long activity, Runnable first, Runnable second) throws Exception {
        var tx = new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        var started = new CountDownLatch(1);
        try (var worker = Executors.newSingleThreadExecutor()) {
            var queued = tx.execute(status -> {
                activityMapper.lockById(activity);
                first.run();
                var task = worker.submit(() -> { started.countDown(); second.run(); });
                try {
                    assertThat(started.await(10, TimeUnit.SECONDS)).isTrue();
                    assertThat(task.isDone()).isFalse();
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(exception);
                }
                return task;
            });
            queued.get(20, TimeUnit.SECONDS);
        }
    }

    private static void expectCancelled(Runnable operation) {
        assertThatThrownBy(operation::run).isInstanceOf(ApiException.class)
            .satisfies(error -> assertThat(((ApiException) error).code()).isEqualTo("ACTIVITY_CANCELLED"));
    }

    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static String readPath(long id) { return "/api/me/notifications/" + id + "/read"; }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time, ZoneOffset.UTC); }
    private List<Map<String, Object>> notificationRows(long activity) { return jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", activity); }
    private List<Map<String, Object>> registrationsRows(long activity) { return jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", activity); }
}

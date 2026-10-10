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
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
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

    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
    static class TestConfiguration {
        @Bean @Primary MutableClock notificationClock() { return new MutableClock(); }
        @Bean NotificationInterceptor notificationInterceptor() { return new NotificationInterceptor(); }
    }

    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return time.get(); }
    }

    record WriteFault(String method, boolean after, Runnable action) {}

    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class NotificationInterceptor implements Interceptor {
        final AtomicReference<Runnable> afterUnreadCount = new AtomicReference<>();
        final AtomicReference<WriteFault> writeFault = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            String id = ((MappedStatement) invocation.getArgs()[0]).getId();
            WriteFault fault = writeFault.get();
            if (fault != null && id.equals(NotificationMapper.class.getName() + "." + fault.method())
                && writeFault.compareAndSet(fault, null)) {
                if (!fault.after()) fault.action().run();
                Object value = invocation.proceed();
                if (fault.after()) fault.action().run();
                return value;
            }
            Object value = invocation.proceed();
            if (id.equals(NotificationMapper.class.getName() + ".unreadCount")) {
                Runnable action = afterUnreadCount.getAndSet(null);
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
        hooks.writeFault.set(null);
        clock.time.set(NOW);
        for (long id : activityIds) {
            jdbc.update("DELETE FROM notifications WHERE activity_id=?", id);
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
        for (long id : userIds) jdbc.update("DELETE FROM users WHERE id=?", id);
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
            new String[]{"status", "UNKNOWN"}, new String[]{"status", "ACTIVE"})) {
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
            var page = notifications.page(member, 1, 10, "UNREAD");
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
        for (String path : List.of("/api/me/notifications", "/api/me/notifications/unread-count", readPath(notice))) {
            var result = (path.endsWith("/read")
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
        var rejected = mvc.perform(post(readPath(notice))).andExpect(status().isForbidden()).andReturn();
        String requestId = rejected.getResponse().getHeader("X-Request-Id");
        String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(requestId)
            && value.contains("http_request")).findFirst().orElseThrow();
        assertThat(json.readTree(line).get("route").asString()).isEqualTo("/api/me/notifications/{id}/read");
    }

    private long createActivity(int capacity) {
        long id = activities.create(new CreateActivityRequest("Notification " + UUID.randomUUID(), "Notification fixture", "Test venue",
            NOW.plusSeconds(3600), capacity), adminId()).id();
        activityIds.add(id);
        return id;
    }

    private long createUser() {
        String username = "notice_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Notification fixture", "USER");
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private long insertNotice(long activity, long member, Instant createdAt, Instant readAt) {
        jdbc.update("INSERT INTO notifications(user_id, activity_id, type, activity_title, created_at, read_at) VALUES(?, ?, 'PROMOTED', 'Fixture notification', ?, ?)",
            member, activity, utc(createdAt), readAt == null ? null : utc(readAt));
        return jdbc.queryForObject("SELECT MAX(id) FROM notifications WHERE activity_id=? AND user_id=?", Long.class, activity, member);
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

package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.api.MyRegistrationModels.*;
import com.example.gather.domain.ActivityLockRow;
import com.example.gather.domain.RegistrationRow;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.monitoring.MonitoringService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Set;

@Service
public class RegistrationService {
    private static final Set<String> SEARCH_STATUSES = Set.of("ALL", "ACTIVE", "WAITING", "CANCELLED");
    private final ActivityMapper activities;
    private final RegistrationMapper registrations;
    private final ActivityService activityService;
    private final NotificationService notifications;
    private final Clock clock;
    private final MonitoringService monitoring;

    public RegistrationService(ActivityMapper activities, RegistrationMapper registrations, ActivityService activityService, NotificationService notifications, Clock clock, MonitoringService monitoring) {
        this.activities = activities;
        this.registrations = registrations;
        this.activityService = activityService;
        this.notifications = notifications;
        this.clock = clock;
        this.monitoring = monitoring;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView register(long activityId, long userId) {
        ActivityLockRow activity = lockOpenActivity(activityId, true);
        RegistrationRow existing = registrations.findByActivityAndUser(activityId, userId);
        // Existing ACTIVE/WAITING requests are idempotent, even when the activity has since filled up.
        if (existing != null && (existing.status().equals("ACTIVE") || existing.status().equals("WAITING"))) {
            return activityService.get(activityId, userId);
        }
        if (activity.registeredCount() < activity.capacity()) {
            activities.changeRegisteredCount(activityId, 1);
            if (existing == null) registrations.insert(activityId, userId);
            else registrations.changeStatus(existing.id(), "ACTIVE");
        } else if (existing == null) {
            registrations.insertWaiting(activityId, userId);
        } else {
            // Rejoining after cancellation while full appends the user to the queue by refreshing updated_at.
            registrations.changeStatus(existing.id(), "WAITING");
        }
        return activityService.get(activityId, userId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView cancel(long activityId, long userId) {
        lockOpenActivity(activityId, false);
        RegistrationRow existing = registrations.findByActivityAndUser(activityId, userId);
        if (existing != null && existing.status().equals("ACTIVE")) {
            registrations.changeStatus(existing.id(), "CANCELLED");
            activities.changeRegisteredCount(activityId, -1);
            RegistrationRow waiting = registrations.findEarliestWaiting(activityId);
            if (waiting != null) {
                registrations.changeStatus(waiting.id(), "ACTIVE");
                activities.changeRegisteredCount(activityId, 1);
                notifications.promoted(activityId, waiting.userId());
            }
        } else if (existing != null && existing.status().equals("WAITING")) {
            registrations.changeStatus(existing.id(), "CANCELLED");
        }
        return activityService.get(activityId, userId);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public List<RegistrationView> mine(long userId) {
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        return registrations.findMine(userId).stream()
            .map(row -> new RegistrationView(row.registrationId(), row.status(), ActivityView.from(row.activity(), now))).toList();
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public MyRegistrationPageView searchMine(long userId, int page, int pageSize, String status) {
        return searchMine(userId, page, pageSize, status, "");
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public MyRegistrationPageView searchMine(long userId, int page, int pageSize, String status, String keyword) {
        if (page < 1 || pageSize < 1 || pageSize > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "页码至少为 1，每页数量应在 1 到 100 之间");
        }
        if (status == null || !SEARCH_STATUSES.contains(status)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "报名筛选状态不正确");
        }
        if (keyword == null || keyword.length() > 200) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "关键词最多 200 个字符");
        }
        // Aggregate and joined page share the transaction's InnoDB snapshot and one UTC microsecond instant.
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        var totals = registrations.mineTotals(userId, status, keyword);
        long offset = ((long) page - 1L) * pageSize;
        var items = registrations.searchMine(userId, status, keyword, pageSize, offset).stream()
            .map(row -> new MyRegistrationView(row.registrationId(), row.status(), ActivityView.from(row.activity(), now),
                row.checkedInAt() == null ? null : row.checkedInAt().toInstant(ZoneOffset.UTC))).toList();
        return new MyRegistrationPageView(items, totals.total(), page, pageSize,
            new MyRegistrationSummary(totals.activeRegistrations(), totals.waitingRegistrations(),
                totals.cancelledRegistrations(), totals.checkedInRegistrations()));
    }

    private ActivityLockRow lockOpenActivity(long activityId, boolean registering) {
        ActivityLockRow activity = monitoring.measureRegistrationLock(() -> activities.lockById(activityId));
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        if (activity.cancelledAt() != null) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，报名和取消报名已关闭");
        }
        // Check after acquiring the lock: a request waiting for a seat may cross the start time.
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        if (!activity.startsAt().toInstant(ZoneOffset.UTC).isAfter(now)) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CLOSED", "活动已开始，报名和取消已关闭");
        }
        if (registering && activity.registrationDeadline() != null
            && !activity.registrationDeadline().toInstant(ZoneOffset.UTC).isAfter(now)) {
            throw new ApiException(HttpStatus.CONFLICT, "REGISTRATION_CLOSED", "活动报名已截止，仍可在开始前取消报名");
        }
        return activity;
    }
}

package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.ActivityLockRow;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.RegistrationMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Set;

@Service
public class ActivityService {
    private static final Set<String> SEARCH_STATUSES = Set.of("ALL", "OPEN", "FULL", "STARTED", "CANCELLED", "UPCOMING");
    private final ActivityMapper activities;
    private final RegistrationMapper registrations;
    private final NotificationService notifications;
    private final AuditLogService audit;
    private final Clock clock;

    public ActivityService(ActivityMapper activities, RegistrationMapper registrations, NotificationService notifications,
                           AuditLogService audit, Clock clock) {
        this.activities = activities;
        this.registrations = registrations;
        this.notifications = notifications;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ActivityView> list(Long userId) {
        var now = clock.instant();
        return activities.findAll(userId).stream().map(row -> ActivityView.from(row, now)).toList();
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public ActivitySearchPageView search(int page, int pageSize, String keyword, String status, Long userId) {
        return search(page, pageSize, keyword, status, "ALL", userId);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public ActivitySearchPageView search(int page, int pageSize, String keyword, String status, String category, Long userId) {
        if (page < 1 || pageSize < 1 || pageSize > 100) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "页码至少为 1，每页数量应在 1 到 100 之间");
        }
        if (keyword == null || keyword.length() > 200) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "搜索关键词最多 200 字");
        }
        if (status == null || !SEARCH_STATUSES.contains(status)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "筛选状态不正确");
        }
        ActivityCategories.filter(category);
        // One microsecond UTC instant and one InnoDB snapshot cover the aggregate and page response.
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        LocalDateTime utcNow = LocalDateTime.ofInstant(now, ZoneOffset.UTC);
        var totals = activities.searchTotals(utcNow, keyword, status, category);
        long offset = ((long) page - 1L) * pageSize;
        var items = activities.search(userId, utcNow, keyword, status, category, pageSize, offset).stream()
            .map(row -> ActivityView.from(row, now)).toList();
        return new ActivitySearchPageView(items, totals.total(), page, pageSize,
            new ActivitySearchSummary(totals.upcomingActivities(), totals.availableSeats()));
    }

    @Transactional(readOnly = true)
    public ActivityView get(long id, Long userId) {
        ActivityRow row = activities.findById(id, userId);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return ActivityView.from(row, clock.instant());
    }

    @Transactional
    public ActivityView create(CreateActivityRequest request, long creatorId) {
        String category = ActivityCategories.value(request.category() == null ? "UNCATEGORIZED" : request.category());
        Instant now = clock.instant();
        Instant startsAt = request.startsAt().truncatedTo(ChronoUnit.MICROS);
        if (!startsAt.isAfter(now)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "开始时间必须在未来");
        }
        NewActivity row = new NewActivity(request.title().strip(), request.description().strip(), request.location().strip(),
            LocalDateTime.ofInstant(startsAt, ZoneOffset.UTC), request.capacity(), creatorId, category);
        activities.insert(row);
        audit.created(row, creatorId, now);
        return get(row.id, creatorId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView edit(long id, EditActivityRequest request, long adminId) {
        ActivityLockRow activity = lockActivity(id);
        if (activity.cancelledAt() != null) cancelled();
        Instant now = clock.instant();
        ensureNotStarted(activity, now);
        String title = editText(request.title(), 100, "标题");
        String description = editText(request.description(), 10000, "介绍");
        String location = editText(request.location(), 200, "地点");
        var before = activities.auditText(id);
        String category = request.category() == null ? before.category() : ActivityCategories.value(request.category());
        if (!before.title().equals(title) || !before.description().equals(description) || !before.location().equals(location)
            || !before.category().equals(category)) {
            activities.edit(id, title, description, location, category);
            audit.edited(id, adminId, before, title, description, location, category, now);
        }
        return get(id, adminId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView cancel(long id, CancelActivityRequest request, long adminId) {
        String reason = cancellationReason(request.reason());
        ActivityLockRow activity = lockActivity(id);
        // A successful cancellation remains idempotent even after the original start time.
        if (activity.cancelledAt() != null) return get(id, adminId);
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        ensureNotStarted(activity, now);
        LocalDateTime cancelledAt = LocalDateTime.ofInstant(now, ZoneOffset.UTC);
        notifications.activityCancelled(id, reason, cancelledAt);
        registrations.cancelForActivity(id, cancelledAt);
        activities.cancel(id, cancelledAt, reason, adminId);
        audit.cancelled(id, adminId, reason, cancelledAt);
        return get(id, adminId);
    }

    private ActivityLockRow lockActivity(long id) {
        ActivityLockRow activity = activities.lockById(id);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return activity;
    }

    private static void ensureNotStarted(ActivityLockRow activity, Instant now) {
        if (!activity.startsAt().toInstant(ZoneOffset.UTC).isAfter(now)) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CLOSED", "活动已开始，不能编辑或取消活动");
        }
    }

    private static void cancelled() {
        throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，不能编辑");
    }

    private static String editText(String value, int max, String field) {
        String text = value == null ? "" : value.strip();
        if (text.isEmpty() || text.length() > max) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field + "不能为空且最多 " + max + " 字");
        }
        return text;
    }

    private static String cancellationReason(String value) {
        String reason = value == null ? "" : value.strip();
        if (reason.isEmpty() || reason.length() > 500
            || value.chars().anyMatch(character -> Character.isISOControl(character) || character == 0x2028 || character == 0x2029)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "取消原因应为 1 到 500 字的单行文字，不得包含控制字符");
        }
        return reason;
    }
}

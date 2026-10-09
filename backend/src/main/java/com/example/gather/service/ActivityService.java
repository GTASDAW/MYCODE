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

@Service
public class ActivityService {
    private final ActivityMapper activities;
    private final RegistrationMapper registrations;
    private final Clock clock;

    public ActivityService(ActivityMapper activities, RegistrationMapper registrations, Clock clock) {
        this.activities = activities;
        this.registrations = registrations;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ActivityView> list(Long userId) {
        var now = clock.instant();
        return activities.findAll(userId).stream().map(row -> ActivityView.from(row, now)).toList();
    }

    @Transactional(readOnly = true)
    public ActivityView get(long id, Long userId) {
        ActivityRow row = activities.findById(id, userId);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return ActivityView.from(row, clock.instant());
    }

    @Transactional
    public ActivityView create(CreateActivityRequest request, long creatorId) {
        if (!request.startsAt().isAfter(clock.instant())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "开始时间必须在未来");
        }
        NewActivity row = new NewActivity(request.title().strip(), request.description().strip(), request.location().strip(),
            LocalDateTime.ofInstant(request.startsAt(), ZoneOffset.UTC), request.capacity(), creatorId);
        activities.insert(row);
        return get(row.id, creatorId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView edit(long id, EditActivityRequest request, long adminId) {
        ActivityLockRow activity = lockActivity(id);
        if (activity.cancelledAt() != null) cancelled();
        ensureNotStarted(activity, clock.instant());
        activities.edit(id, editText(request.title(), 100, "标题"),
            editText(request.description(), 10000, "介绍"), editText(request.location(), 200, "地点"));
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
        registrations.cancelForActivity(id, cancelledAt);
        activities.cancel(id, cancelledAt, reason, adminId);
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

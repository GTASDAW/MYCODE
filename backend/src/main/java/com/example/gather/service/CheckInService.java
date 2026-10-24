package com.example.gather.service;

import com.example.gather.api.AdminModels.RosterView;
import com.example.gather.api.ApiException;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import com.example.gather.api.CheckInModels.CorrectCheckInRequest;
import com.example.gather.domain.RosterRow;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

/** Attendance writes have their own transaction boundary, sharing the registration parent lock. */
@Service
public class CheckInService {
    private final ActivityMapper activities;
    private final AdminMapper admin;
    private final AuditLogService audit;
    private final Clock clock;

    public CheckInService(ActivityMapper activities, AdminMapper admin, AuditLogService audit, Clock clock) {
        this.activities = activities;
        this.admin = admin;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public RosterView checkIn(long activityId, long registrationId, long adminId) {
        return checkIn(activityId, registrationId, adminId, null);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public RosterView checkIn(long activityId, long registrationId, long adminId, Long expectedVersion) {
        var context = lockEligible(activityId, registrationId);
        var existing = context.registration();
        verifyVersion(expectedVersion, existing.checkInVersion());
        if (existing.checkedInAt() != null) return RosterView.from(existing);
        saveCheckIn(activityId, registrationId, adminId, context.now(), null);
        return RosterView.from(admin.findRosterRegistration(activityId, registrationId));
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public RosterView correct(long activityId, long registrationId, long adminId, CorrectCheckInRequest request) {
        if (request == null || request.checkedIn() == null || request.expectedVersion() == null
            || request.reason() == null || request.reason().isBlank() || request.reason().length() > 500
            || request.reason().matches("(?s).*[\\r\\n\\u000B\\u000C\\u0085\\u2028\\u2029].*")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "请选择签到状态，并填写 1 到 500 字的单行更正原因和签到版本");
        }
        var context = lockEligible(activityId, registrationId);
        var existing = context.registration();
        verifyVersion(request.expectedVersion(), existing.checkInVersion());
        if (request.checkedIn() == (existing.checkedInAt() != null)) return RosterView.from(existing);
        String reason = request.reason().strip();
        if (request.checkedIn()) {
            saveCheckIn(activityId, registrationId, adminId, context.now(), reason);
        } else {
            if (admin.revokeCheckIn(registrationId) != 1) throw new IllegalStateException("Locked registration check-in was not revoked");
            audit.checkInRevoked(activityId, adminId, existing, reason, context.now());
        }
        return RosterView.from(admin.findRosterRegistration(activityId, registrationId));
    }

    private Context lockEligible(long activityId, long registrationId) {
        var activity = activities.lockById(activityId);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        var existing = admin.findRosterRegistration(activityId, registrationId);
        if (existing == null) throw new ApiException(HttpStatus.NOT_FOUND, "REGISTRATION_NOT_FOUND", "报名记录不存在");
        if (activity.cancelledAt() != null) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，不能签到");
        }
        // A queued request can cross the start boundary while waiting for the same activity lock.
        var now = LocalDateTime.ofInstant(clock.instant().truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC);
        if (activity.startsAt().isAfter(now)) {
            throw new ApiException(HttpStatus.CONFLICT, "CHECK_IN_NOT_OPEN", "活动开始后才开放签到");
        }
        if (!existing.status().equals("ACTIVE")) {
            throw new ApiException(HttpStatus.CONFLICT, "REGISTRATION_NOT_ACTIVE", "只有有效报名者可以签到");
        }
        return new Context(existing, now);
    }

    private void saveCheckIn(long activityId, long registrationId, long adminId, LocalDateTime now, String reason) {
        if (admin.checkIn(registrationId, now, adminId) != 1) {
            throw new IllegalStateException("Locked registration check-in was not saved");
        }
        audit.checkedIn(activityId, adminId, registrationId, "ADMIN", adminId, reason, now);
    }

    static void verifyVersion(Long expected, long actual) {
        if (expected != null && expected < 0) throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "签到版本不正确");
        if (expected != null && expected != actual)
            throw new ApiException(HttpStatus.CONFLICT, "CHECK_IN_VERSION_CONFLICT", "签到状态已变化，请刷新报名记录后重试");
    }

    private record Context(RosterRow registration, LocalDateTime now) {}
}

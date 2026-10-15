package com.example.gather.service;

import com.example.gather.api.AdminModels.RosterView;
import com.example.gather.api.ApiException;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
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
        if (existing.checkedInAt() != null) return RosterView.from(existing);
        if (admin.checkIn(registrationId, now, adminId) != 1) {
            throw new IllegalStateException("Locked registration check-in was not saved");
        }
        audit.checkedIn(activityId, adminId, registrationId, now);
        return RosterView.from(admin.findRosterRegistration(activityId, registrationId));
    }
}

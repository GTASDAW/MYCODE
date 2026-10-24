package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.MyRegistrationModels.MyRegistrationView;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.maps.LocationCoordinateConverter.Point;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

@Service
public class LocationCheckInWriter {
    private final ActivityMapper activities;
    private final RegistrationMapper registrations;
    private final AuditLogService audit;
    private final Clock clock;
    public LocationCheckInWriter(ActivityMapper activities, RegistrationMapper registrations, AuditLogService audit, Clock clock) {
        this.activities = activities; this.registrations = registrations; this.audit = audit; this.clock = clock;
    }
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public MyRegistrationView checkIn(long activityId, long registrationId, long userId, long expectedVersion, Point point) {
        var activity = activities.lockById(activityId);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "REGISTRATION_NOT_FOUND", "报名记录不存在");
        var registration = registrations.findMineCheckIn(registrationId, userId);
        if (registration == null || registration.activityId() != activityId)
            throw new ApiException(HttpStatus.NOT_FOUND, "REGISTRATION_NOT_FOUND", "报名记录不存在");
        CheckInService.verifyVersion(expectedVersion, registration.checkInVersion());
        if (activity.cancelledAt() != null) throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，不能签到");
        if (!registration.status().equals("ACTIVE"))
            throw new ApiException(HttpStatus.CONFLICT, "REGISTRATION_NOT_ACTIVE", "只有有效报名者可以签到");
        var target = activities.locationCheckInTarget(activityId);
        var instant = clock.instant().truncatedTo(ChronoUnit.MICROS);
        var now = LocalDateTime.ofInstant(instant, ZoneOffset.UTC);
        if (target == null || target.endsAt() == null || target.locationLongitude() == null || target.locationLatitude() == null)
            throw new ApiException(HttpStatus.CONFLICT, "LOCATION_CHECK_IN_UNAVAILABLE", "此活动未配置地点坐标或结束时间，请联系管理员签到");
        if (activity.startsAt().isAfter(now) || !target.endsAt().isAfter(now))
            throw new ApiException(HttpStatus.CONFLICT, "LOCATION_CHECK_IN_CLOSED", "定位签到仅在活动开始后、结束前开放");
        if (registration.checkedInAt() != null) return MyRegistrationView.from(registrations.findMineById(registrationId, userId), instant);
        if (point == null) throw new IllegalStateException("A converted location is required before an attendance write");
        double distance = LocationDistance.meters(point.longitude().doubleValue(), point.latitude().doubleValue(),
            target.locationLongitude().doubleValue(), target.locationLatitude().doubleValue());
        if (!Double.isFinite(distance) || distance > 300)
            throw new ApiException(HttpStatus.CONFLICT, "LOCATION_OUT_OF_RANGE", "请到活动地点 300 米范围内再签到");
        if (registrations.selfCheckIn(registrationId, now, expectedVersion) != 1)
            throw new IllegalStateException("Locked location check-in was not saved");
        audit.checkedIn(activityId, userId, registrationId, "SELF_LOCATION", null, null, now);
        return MyRegistrationView.from(registrations.findMineById(registrationId, userId), instant);
    }
}

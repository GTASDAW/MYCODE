package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.CheckInModels.LocationCheckInRequest;
import com.example.gather.api.MyRegistrationModels.MyRegistrationView;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.maps.LocationCoordinateConverter;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import java.math.BigDecimal;

/** Preflight and external conversion deliberately run outside the locked writer's transaction. */
@Service
public class LocationCheckInService {
    private final RegistrationMapper registrations;
    private final LocationCoordinateConverter converter;
    private final LocationCheckInWriter writer;
    public LocationCheckInService(RegistrationMapper registrations, LocationCoordinateConverter converter, LocationCheckInWriter writer) {
        this.registrations = registrations; this.converter = converter; this.writer = writer;
    }
    public MyRegistrationView checkIn(long registrationId, long userId, LocationCheckInRequest request) {
        validate(request);
        var existing = registrations.findMineCheckIn(registrationId, userId);
        if (existing == null) throw new ApiException(HttpStatus.NOT_FOUND, "REGISTRATION_NOT_FOUND", "报名记录不存在");
        CheckInService.verifyVersion(request.expectedVersion(), existing.checkInVersion());
        if (!existing.status().equals("ACTIVE"))
            throw new ApiException(HttpStatus.CONFLICT, "REGISTRATION_NOT_ACTIVE", "只有有效报名者可以签到");
        var point = existing.checkedInAt() == null ? converter.convert(request.longitude(), request.latitude()) : null;
        return writer.checkIn(existing.activityId(), registrationId, userId, request.expectedVersion(), point);
    }
    private static void validate(LocationCheckInRequest request) {
        if (request == null || request.expectedVersion() == null || request.expectedVersion() < 0
            || request.longitude() == null || request.longitude().scale() > 18 || request.longitude().abs().compareTo(BigDecimal.valueOf(180)) > 0
            || request.latitude() == null || request.latitude().scale() > 18 || request.latitude().abs().compareTo(BigDecimal.valueOf(90)) > 0
            || request.accuracyMeters() == null || request.accuracyMeters().signum() <= 0
            || request.accuracyMeters().scale() > 18 || request.accuracyMeters().compareTo(BigDecimal.valueOf(100)) > 0)
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "请提供有效定位、0 到 100 米以内的精度和签到版本");
    }
}

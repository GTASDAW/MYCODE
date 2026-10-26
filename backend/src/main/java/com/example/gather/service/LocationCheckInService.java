package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.CheckInModels.LocationCheckInRequest;
import com.example.gather.api.MyRegistrationModels.MyRegistrationView;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.maps.LocationCoordinateConverter;
import com.example.gather.maps.LocationCheckInConfiguration;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import java.math.BigDecimal;

/** Preflight and external conversion deliberately run outside the locked writer's transaction. */
@Service
public class LocationCheckInService {
    private final RegistrationMapper registrations;
    private final LocationCoordinateConverter converter;
    private final LocationCheckInWriter writer;
    private final LocationCheckInConfiguration configuration;
    private enum InputCoordinates { WGS84, GCJ02 }

    public LocationCheckInService(RegistrationMapper registrations, LocationCoordinateConverter converter,
                                 LocationCheckInWriter writer, LocationCheckInConfiguration configuration) {
        this.registrations = registrations; this.converter = converter; this.writer = writer; this.configuration = configuration;
    }
    public MyRegistrationView checkIn(long registrationId, long userId, LocationCheckInRequest request) {
        return checkIn(registrationId, userId, request, InputCoordinates.WGS84);
    }
    public MyRegistrationView checkInGcj02(long registrationId, long userId, LocationCheckInRequest request) {
        if (!configuration.gcj02DiagnosticEnabled())
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "LOCATION_DIAGNOSTIC_DISABLED", "定位兼容诊断未启用，请使用正常签到或联系管理员现场确认。");
        return checkIn(registrationId, userId, request, InputCoordinates.GCJ02);
    }
    private MyRegistrationView checkIn(long registrationId, long userId, LocationCheckInRequest request, InputCoordinates coordinates) {
        validate(request);
        var existing = registrations.findLocationCheckInPreflight(registrationId, userId);
        if (existing == null) throw new ApiException(HttpStatus.NOT_FOUND, "REGISTRATION_NOT_FOUND", "报名记录不存在");
        CheckInService.verifyVersion(request.expectedVersion(), existing.checkInVersion());
        if (!existing.status().equals("ACTIVE"))
            throw new ApiException(HttpStatus.CONFLICT, "REGISTRATION_NOT_ACTIVE", "只有有效报名者可以签到");
        LocationCoordinateConverter.Point point = null;
        if (existing.checkedInAt() == null) {
            if (existing.cancelledAt() != null)
                throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，不能签到");
            if (existing.endsAt() == null || existing.locationLongitude() == null || existing.locationLatitude() == null)
                throw new ApiException(HttpStatus.CONFLICT, "LOCATION_CHECK_IN_UNAVAILABLE", "此活动未配置地点坐标或结束时间，请联系管理员签到");
            if (!configuration.enabled())
                throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "LOCATION_CHECK_IN_UNAVAILABLE", "定位签到服务暂时不可用，请稍后重试或联系管理员签到");
            // Do not decide the time window here: conversion or parent-lock waits may cross the start boundary.
            // The route declares one encoding. Never infer it from a browser or compare both interpretations.
            point = coordinates == InputCoordinates.GCJ02
                ? new LocationCoordinateConverter.Point(request.longitude(), request.latitude())
                : converter.convert(request.longitude(), request.latitude());
        }
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

package com.example.gather.api;

import org.springframework.http.HttpStatus;
import java.math.BigDecimal;
import java.math.RoundingMode;

/** Persisted and published coordinates always use the AMap GCJ-02 coordinate system. */
public record LocationPoint(BigDecimal longitude, BigDecimal latitude) {
    public LocationPoint {
        if (longitude == null || latitude == null || longitude.abs().compareTo(BigDecimal.valueOf(180)) > 0
            || latitude.abs().compareTo(BigDecimal.valueOf(90)) > 0
            || Math.abs((long) longitude.scale()) > 1000 || Math.abs((long) latitude.scale()) > 1000) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "地图选点必须同时提供有效经纬度");
        }
        // Validate the original value first: 180.00000001 must not round into the permitted range.
        longitude = longitude.setScale(7, RoundingMode.HALF_UP);
        latitude = latitude.setScale(7, RoundingMode.HALF_UP);
    }

    public static LocationPoint from(BigDecimal longitude, BigDecimal latitude) {
        return longitude == null && latitude == null ? null : new LocationPoint(longitude, latitude);
    }
}

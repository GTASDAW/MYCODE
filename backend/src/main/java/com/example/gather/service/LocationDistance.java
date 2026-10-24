package com.example.gather.service;

/** Haversine on the same GCJ02 coordinate system; reported accuracy never increases the allowed radius. */
public final class LocationDistance {
    private static final double EARTH_RADIUS_METERS = 6_371_008.8;
    private LocationDistance() {}
    public static double meters(double longitudeA, double latitudeA, double longitudeB, double latitudeB) {
        double latA = Math.toRadians(latitudeA), latB = Math.toRadians(latitudeB);
        double latDelta = latB - latA, lonDelta = Math.toRadians(longitudeB - longitudeA);
        double value = Math.pow(Math.sin(latDelta / 2), 2)
            + Math.cos(latA) * Math.cos(latB) * Math.pow(Math.sin(lonDelta / 2), 2);
        return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, value))));
    }
}

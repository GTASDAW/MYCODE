package com.example.gather.monitoring;

import java.time.Instant;
import java.util.List;

public final class MonitoringModels {
    private MonitoringModels() {}

    public record MonitoringView(String instanceId, Instant startedAt, Instant sampledAt, String scope,
                                 long totalRequests, long clientErrors, long serverErrors,
                                 double serverErrorRate, double averageDurationMs, int latencyWindowSeconds,
                                 List<RouteView> routes, TimerView registrationLock, DatabasePoolView databasePool) {}

    public record RouteView(String method, String route, int status, long count, double averageDurationMs,
                            Double maxDurationMs, Double p95DurationMs) {}

    public record TimerView(long count, double averageDurationMs, Double maxDurationMs, Double p95DurationMs) {}

    public record DatabasePoolView(Integer active, Integer idle, Integer pending, Integer max) {}
}

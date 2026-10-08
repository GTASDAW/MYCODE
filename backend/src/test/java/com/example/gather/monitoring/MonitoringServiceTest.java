package com.example.gather.monitoring;

import io.micrometer.core.instrument.MockClock;
import io.micrometer.core.instrument.distribution.HistogramSnapshot;
import io.micrometer.core.instrument.simple.SimpleConfig;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import javax.sql.DataSource;
import java.lang.management.ManagementFactory;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

class MonitoringServiceTest {
    private final MockClock clock = new MockClock();
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry(SimpleConfig.DEFAULT, clock);
    private final MonitoringService monitoring = new MonitoringService(registry, mock(DataSource.class), "unit-test");

    @AfterEach
    void closeRegistry() { registry.close(); }

    @Test
    void emptySamplesHaveZeroCountersAndNullWindowValues() {
        var view = monitoring.snapshot();
        assertThat(view.startedAt()).isEqualTo(Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime()));
        assertThat(view.sampledAt()).isAfterOrEqualTo(view.startedAt());
        assertThat(view.totalRequests()).isZero();
        assertThat(view.serverErrorRate()).isZero();
        assertThat(view.averageDurationMs()).isZero();
        assertThat(view.routes()).isEmpty();
        assertThat(view.registrationLock().count()).isZero();
        assertThat(view.registrationLock().averageDurationMs()).isZero();
        assertThat(view.registrationLock().maxDurationMs()).isNull();
        assertThat(view.registrationLock().p95DurationMs()).isNull();
        assertThat(view.databasePool().active()).isNull();
        assertThat(MonitoringService.percentile95(HistogramSnapshot.empty(1, 1, 1))).isNull();
    }

    @Test
    void totalsUseWeightedDurationAndSeparate4xxFrom5xxWithoutAveragingPercentiles() {
        for (int i = 0; i < 3; i++) record("GET", "/api/activities", 200, 10);
        record("POST", "/api/activities/{id}/registration", 500, 100);
        record("GET", "/api/activities/{id}", 404, 40);
        var view = monitoring.snapshot();
        assertThat(view.scope()).isEqualTo("CURRENT_JVM");
        assertThat(view.instanceId()).isEqualTo("unit-test");
        assertThat(view.totalRequests()).isEqualTo(5);
        assertThat(view.clientErrors()).isEqualTo(1);
        assertThat(view.serverErrors()).isEqualTo(1);
        assertThat(view.serverErrorRate()).isEqualTo(0.2);
        assertThat(view.averageDurationMs()).isCloseTo(34, within(0.00001));
        assertThat(view.routes()).hasSize(3);
        var registrations = view.routes().stream().filter(route -> route.method().equals("POST")).findFirst().orElseThrow();
        assertThat(registrations.count()).isEqualTo(1);
        assertThat(registrations.averageDurationMs()).isEqualTo(100);
        assertThat(registrations.maxDurationMs()).isEqualTo(100);
        assertThat(registrations.p95DurationMs()).isCloseTo(100, within(10.0));
        assertThat(view.latencyWindowSeconds()).isEqualTo(300);
    }

    @Test
    void expiredPercentilesAndMaximumBecomeNullWhileLifetimeCountsAndMeansRemain() {
        record("GET", "/api/activities", 200, 80);
        var before = monitoring.snapshot().routes().getFirst();
        assertThat(before.p95DurationMs()).isPositive();
        assertThat(before.maxDurationMs()).isEqualTo(80);
        clock.add(Duration.ofSeconds(301));
        var expired = monitoring.snapshot().routes().getFirst();
        assertThat(expired.count()).isEqualTo(1);
        assertThat(expired.averageDurationMs()).isEqualTo(80);
        assertThat(expired.p95DurationMs()).isNull();
        assertThat(expired.maxDurationMs()).isNull();
        record("GET", "/api/activities", 200, 10);
        var fresh = monitoring.snapshot().routes().getFirst();
        assertThat(fresh.count()).isEqualTo(2);
        assertThat(fresh.averageDurationMs()).isEqualTo(45);
        assertThat(fresh.maxDurationMs()).isEqualTo(10);
        assertThat(fresh.p95DurationMs()).isCloseTo(10, within(2.0));
    }

    @Test
    void lockSelectionIncludesExecutionAndFailuresWithoutIdentityLabels() {
        String result = monitoring.measureRegistrationLock(() -> {
            clock.add(Duration.ofMillis(12));
            return "row";
        });
        assertThat(result).isEqualTo("row");
        assertThatThrownBy(() -> monitoring.measureRegistrationLock(() -> {
            clock.add(Duration.ofMillis(8));
            throw new IllegalStateException("failure");
        })).isInstanceOf(IllegalStateException.class);
        var lock = monitoring.snapshot().registrationLock();
        assertThat(lock.count()).isEqualTo(2);
        assertThat(lock.averageDurationMs()).isEqualTo(10);
        assertThat(lock.maxDurationMs()).isEqualTo(12);
        assertThat(registry.get(MonitoringService.LOCK_TIMER).timer().getId().getTags()).isEmpty();
        clock.add(Duration.ofSeconds(301));
        assertThat(monitoring.snapshot().registrationLock().p95DurationMs()).isNull();
    }

    @Test
    void healthAndMonitoringReadsCannotChangeBusinessRequestCounters() {
        record("GET", "/api/health", 200, 10);
        record("GET", "/api/admin/monitoring", 401, 10);
        assertThat(monitoring.snapshot().totalRequests()).isZero();
        assertThat(registry.find(MonitoringService.HTTP_TIMER).timers()).isEmpty();
    }

    private void record(String method, String route, int status, long milliseconds) {
        monitoring.recordRequest(method, route, status, TimeUnit.MILLISECONDS.toNanos(milliseconds));
    }
}

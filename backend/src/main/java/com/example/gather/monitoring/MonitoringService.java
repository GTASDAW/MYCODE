package com.example.gather.monitoring;

import com.example.gather.monitoring.MonitoringModels.*;
import com.zaxxer.hikari.HikariDataSource;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.distribution.HistogramSnapshot;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import javax.sql.DataSource;
import java.lang.management.ManagementFactory;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/** Cumulative counters and means belong to this JVM; max/P95 are rotating, approximate 5-minute windows. */
@Service
public class MonitoringService {
    public static final String HTTP_TIMER = "gather.http.requests";
    public static final String LOCK_TIMER = "gather.registration.lock";
    public static final int WINDOW_SECONDS = 300;
    private final MeterRegistry registry;
    private final DataSource database;
    private final String instanceId;
    private final Instant startedAt = Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime());
    private final Timer registrationLock;

    public MonitoringService(MeterRegistry registry, DataSource database, @Value("${app.instance-id:local}") String instanceId) {
        this.registry = registry;
        this.database = database;
        this.instanceId = instanceId.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}") ? instanceId : "local";
        this.registrationLock = timer(LOCK_TIMER)
            .description("Activity lock SELECT duration, including query execution and database row-lock wait")
            .register(registry);
    }

    void recordRequest(String method, String route, int status, long durationNanos) {
        if (!RequestRoute.measured(route)) return;
        timer(HTTP_TIMER).description("API duration including Session and Security filters")
            .tags("method", method, "route", route, "status", Integer.toString(status))
            .register(registry).record(durationNanos, TimeUnit.NANOSECONDS);
    }

    public <T> T measureRegistrationLock(Supplier<T> selectForUpdate) {
        // Timer.record also records failed calls; this is NOT a pure MySQL lock-wait measurement.
        return registrationLock.record(selectForUpdate);
    }

    public MonitoringView snapshot() {
        List<RouteView> routes = registry.find(HTTP_TIMER).timers().stream().map(timer -> {
            HistogramSnapshot snapshot = timer.takeSnapshot();
            return new RouteView(timer.getId().getTag("method"), timer.getId().getTag("route"),
                Integer.parseInt(timer.getId().getTag("status")), snapshot.count(),
                snapshot.mean(TimeUnit.MILLISECONDS), recentMax(snapshot), percentile95(snapshot));
        }).sorted(Comparator.comparing(RouteView::route).thenComparing(RouteView::method)
            .thenComparingInt(RouteView::status)).toList();
        long total = 0, clientErrors = 0, serverErrors = 0;
        double totalDurationMs = 0;
        for (RouteView route : routes) {
            total += route.count();
            totalDurationMs += route.averageDurationMs() * route.count();
            if (route.status() >= 400 && route.status() < 500) clientErrors += route.count();
            if (route.status() >= 500) serverErrors += route.count();
        }
        HistogramSnapshot lock = registrationLock.takeSnapshot();
        return new MonitoringView(instanceId, startedAt, Instant.now(), "CURRENT_JVM", total, clientErrors,
            serverErrors, total == 0 ? 0 : (double) serverErrors / total, total == 0 ? 0 : totalDurationMs / total,
            WINDOW_SECONDS, routes, new TimerView(lock.count(), lock.mean(TimeUnit.MILLISECONDS),
                recentMax(lock), percentile95(lock)), pool());
    }

    private static Timer.Builder timer(String name) {
        return Timer.builder(name).publishPercentiles(0.95)
            .distributionStatisticExpiry(Duration.ofSeconds(WINDOW_SECONDS)).distributionStatisticBufferLength(1);
    }

    static Double recentMax(HistogramSnapshot snapshot) {
        return positiveFinite(snapshot.max(TimeUnit.MILLISECONDS));
    }

    static Double percentile95(HistogramSnapshot snapshot) {
        for (var percentile : snapshot.percentileValues()) {
            if (Double.compare(percentile.percentile(), 0.95) == 0) {
                return positiveFinite(percentile.value(TimeUnit.MILLISECONDS));
            }
        }
        return null;
    }

    private static Double positiveFinite(double value) { return Double.isFinite(value) && value > 0 ? value : null; }

    private DatabasePoolView pool() {
        if (database instanceof HikariDataSource hikari && hikari.getHikariPoolMXBean() != null) {
            var pool = hikari.getHikariPoolMXBean();
            return new DatabasePoolView(pool.getActiveConnections(), pool.getIdleConnections(),
                pool.getThreadsAwaitingConnection(), hikari.getMaximumPoolSize());
        }
        return new DatabasePoolView(null, null, null, null);
    }
}

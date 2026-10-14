package com.example.gather.security.ratelimit;

import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import static org.assertj.core.api.Assertions.assertThat;
import static com.example.gather.security.ratelimit.AuthRateLimitStore.Outcome.*;

class MemoryAuthRateLimitStoreTest {
    private static AuthRateLimitStore.Bucket bucket(String name, int limit, int seconds) {
        return new AuthRateLimitStore.Bucket(name, limit, seconds);
    }

    @Test
    void fixedWindowUsesMonotonicTimeAndBlockedAttemptsDoNotExtendIt() {
        AtomicLong clock = new AtomicLong(10_000_000_000L);
        var store = new MemoryAuthRateLimitStore(10, clock::get);
        var buckets = List.of(bucket("pair", 2, 3));
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
        clock.addAndGet(500_000_000L);
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(buckets).retryAfterSeconds()).isEqualTo(3);
        clock.addAndGet(2_499_999_999L);
        assertThat(store.consume(buckets).retryAfterSeconds()).isEqualTo(1);
        clock.incrementAndGet();
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(buckets).outcome()).isEqualTo(LIMITED);
    }

    @Test
    void rejectedPairDoesNotConsumeSourceAndRejectedSourceDoesNotConsumePair() {
        var store = new MemoryAuthRateLimitStore(10, () -> 0);
        var source = bucket("source", 2, 30);
        var first = bucket("first", 1, 30);
        var second = bucket("second", 2, 30);
        assertThat(store.consume(List.of(source, first)).outcome()).isEqualTo(ALLOWED);
        for (int attempt = 0; attempt < 50; attempt++) assertThat(store.consume(List.of(source, first)).outcome()).isEqualTo(LIMITED);
        assertThat(store.consume(List.of(source, second)).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(List.of(source, second)).outcome()).isEqualTo(LIMITED);
        assertThat(store.consume(List.of(second)).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(List.of(second)).outcome()).isEqualTo(LIMITED);
    }

    @Test
    void retryWaitsForEveryBlockingWindow() {
        AtomicLong clock = new AtomicLong();
        var store = new MemoryAuthRateLimitStore(10, clock::get);
        var buckets = List.of(bucket("source", 1, 3), bucket("pair", 1, 7));
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
        clock.set(2_000_000_001L);
        assertThat(store.consume(buckets).retryAfterSeconds()).isEqualTo(5);
        clock.set(3_000_000_000L);
        assertThat(store.consume(buckets).retryAfterSeconds()).isEqualTo(4);
        clock.set(7_000_000_000L);
        assertThat(store.consume(buckets).outcome()).isEqualTo(ALLOWED);
    }

    @Test
    void boundedCapacityNeverEvictsLiveEntriesAndRecoversAtExpiry() {
        AtomicLong clock = new AtomicLong();
        var store = new MemoryAuthRateLimitStore(2, clock::get);
        var full = List.of(bucket("a", 1, 2), bucket("b", 2, 3));
        assertThat(store.consume(full).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(List.of(bucket("c", 1, 2))).outcome()).isEqualTo(UNAVAILABLE);
        assertThat(store.consume(full).outcome()).isEqualTo(LIMITED);
        clock.set(2_000_000_000L);
        assertThat(store.consume(List.of(bucket("c", 1, 2))).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(List.of(bucket("b", 2, 3))).outcome()).isEqualTo(ALLOWED);
        assertThat(store.consume(List.of(bucket("b", 2, 3))).outcome()).isEqualTo(LIMITED);
    }

    @Test
    void simultaneousConsumersCannotOvershootEitherBucket() throws Exception {
        var store = new MemoryAuthRateLimitStore(100, () -> 0);
        var source = bucket("source", 10, 60);
        var pair = bucket("pair", 4, 60);
        var start = new CountDownLatch(1);
        List<Future<AuthRateLimitStore.Decision>> results = new ArrayList<>();
        try (var workers = Executors.newFixedThreadPool(20)) {
            for (int index = 0; index < 100; index++) results.add(workers.submit(() -> {
                if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("barrier timed out");
                return store.consume(List.of(source, pair));
            }));
            start.countDown();
            int allowed = 0;
            for (var result : results) if (result.get(5, TimeUnit.SECONDS).outcome() == ALLOWED) allowed++;
            assertThat(allowed).isEqualTo(4);
        }
        for (int index = 0; index < 6; index++) {
            assertThat(store.consume(List.of(source, bucket("other-" + index, 1, 60))).outcome()).isEqualTo(ALLOWED);
        }
        assertThat(store.consume(List.of(source, bucket("last", 1, 60))).outcome()).isEqualTo(LIMITED);
    }
}

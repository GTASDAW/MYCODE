package com.example.gather.security.ratelimit;

import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.function.LongSupplier;

public final class MemoryAuthRateLimitStore implements AuthRateLimitStore {
    private static final long NANOS_PER_SECOND = 1_000_000_000L;
    private static final class Entry {
        private final String digest;
        private final long expiresAt;
        private int count;
        private Entry(String digest, long expiresAt) { this.digest = digest; this.expiresAt = expiresAt; }
    }
    private final Map<String, Entry> entries = new HashMap<>();
    private final PriorityQueue<Entry> expirations = new PriorityQueue<>(Comparator.comparingLong(entry -> entry.expiresAt));
    private final int maxBuckets;
    private final LongSupplier monotonicClock;

    public MemoryAuthRateLimitStore(int maxBuckets) { this(maxBuckets, System::nanoTime); }

    MemoryAuthRateLimitStore(int maxBuckets, LongSupplier monotonicClock) {
        this.maxBuckets = maxBuckets;
        this.monotonicClock = monotonicClock;
    }

    @Override
    public synchronized Decision consume(List<Bucket> buckets) {
        long now = monotonicClock.getAsLong();
        // Expired entries are removed on every operation, without evicting a live limit.
        while (!expirations.isEmpty() && expirations.peek().expiresAt <= now) {
            Entry expired = expirations.remove();
            entries.remove(expired.digest, expired);
        }
        long retryNanos = 0;
        int missing = 0;
        for (Bucket bucket : buckets) {
            Entry entry = entries.get(bucket.digest());
            if (entry == null) missing++;
            else if (entry.count >= bucket.limit()) retryNanos = Math.max(retryNanos, entry.expiresAt - now);
        }
        if (retryNanos > 0) return Decision.limited((retryNanos + NANOS_PER_SECOND - 1) / NANOS_PER_SECOND);
        if ((long) entries.size() + missing > maxBuckets) return Decision.unavailable();
        for (Bucket bucket : buckets) {
            Entry entry = entries.get(bucket.digest());
            if (entry == null) {
                entry = new Entry(bucket.digest(), now + bucket.windowSeconds() * NANOS_PER_SECOND);
                entries.put(bucket.digest(), entry);
                expirations.add(entry);
            }
            entry.count++;
        }
        return Decision.allowed();
    }
}

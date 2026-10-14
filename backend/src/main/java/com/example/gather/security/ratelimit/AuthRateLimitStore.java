package com.example.gather.security.ratelimit;

import java.util.List;

public interface AuthRateLimitStore {
    record Bucket(String digest, int limit, int windowSeconds) {}
    enum Outcome { ALLOWED, LIMITED, UNAVAILABLE }
    record Decision(Outcome outcome, long retryAfterSeconds) {
        static Decision allowed() { return new Decision(Outcome.ALLOWED, 0); }
        static Decision limited(long seconds) { return new Decision(Outcome.LIMITED, Math.max(1, seconds)); }
        static Decision unavailable() { return new Decision(Outcome.UNAVAILABLE, 0); }
    }

    /** Checks and consumes every bucket atomically; rejection consumes none. */
    Decision consume(List<Bucket> buckets);
}

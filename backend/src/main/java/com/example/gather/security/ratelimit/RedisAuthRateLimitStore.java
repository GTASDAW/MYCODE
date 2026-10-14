package com.example.gather.security.ratelimit;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import java.util.ArrayList;
import java.util.List;

public final class RedisAuthRateLimitStore implements AuthRateLimitStore {
    private static final DefaultRedisScript<List> CONSUME = new DefaultRedisScript<>("""
        local clock = redis.call('TIME')
        local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
        local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
        for _, digest in ipairs(expired) do
            redis.call('HDEL', KEYS[1], digest)
            redis.call('ZREM', KEYS[2], digest)
        end
        if redis.call('HLEN', KEYS[1]) ~= redis.call('ZCARD', KEYS[2]) then return {2, 0} end
        local missing = 0
        local retry = 0
        for i = 2, #ARGV, 3 do
            local count = tonumber(redis.call('HGET', KEYS[1], ARGV[i]))
            local expiry = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[i]))
            if (count and not expiry) or (expiry and not count) then return {2, 0} end
            if not count then missing = missing + 1
            elseif count >= tonumber(ARGV[i + 1]) then retry = math.max(retry, expiry - now) end
        end
        if retry > 0 then return {1, math.ceil(retry / 1000)} end
        if redis.call('ZCARD', KEYS[2]) + missing > tonumber(ARGV[1]) then return {2, 0} end
        for i = 2, #ARGV, 3 do
            if not redis.call('ZSCORE', KEYS[2], ARGV[i]) then
                redis.call('ZADD', KEYS[2], now + tonumber(ARGV[i + 2]) * 1000, ARGV[i])
            end
            redis.call('HINCRBY', KEYS[1], ARGV[i], 1)
        end
        local last = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
        -- Expire namespace storage at the final existing deadline, never extend any bucket window.
        if #last == 2 then
            redis.call('PEXPIREAT', KEYS[1], last[2])
            redis.call('PEXPIREAT', KEYS[2], last[2])
        end
        return {0, 0}
        """, List.class);
    private final StringRedisTemplate redis;
    private final List<String> keys;
    private final int maxBuckets;

    public RedisAuthRateLimitStore(StringRedisTemplate redis, String namespace, int maxBuckets) {
        this.redis = redis;
        // Both fixed keys use one Redis Cluster slot; no scan, per-input key, or shared-session cleanup.
        String prefix = namespace + ":{auth-rate-limit}:";
        this.keys = List.of(prefix + "counts", prefix + "expires");
        this.maxBuckets = maxBuckets;
    }

    @Override
    public Decision consume(List<Bucket> buckets) {
        List<String> arguments = new ArrayList<>();
        arguments.add(Integer.toString(maxBuckets));
        for (Bucket bucket : buckets) {
            arguments.add(bucket.digest());
            arguments.add(Integer.toString(bucket.limit()));
            arguments.add(Integer.toString(bucket.windowSeconds()));
        }
        try {
            List<?> result = redis.execute(CONSUME, keys, arguments.toArray());
            if (result == null || result.size() != 2 || !(result.get(0) instanceof Number outcome)
                || !(result.get(1) instanceof Number retry)) return Decision.unavailable();
            return switch (outcome.intValue()) {
                case 0 -> Decision.allowed();
                case 1 -> retry.longValue() > 0 ? Decision.limited(retry.longValue()) : Decision.unavailable();
                default -> Decision.unavailable();
            };
        } catch (RuntimeException unavailable) {
            // Never leak Redis error text or silently fall back to a different counter store.
            return Decision.unavailable();
        }
    }
}

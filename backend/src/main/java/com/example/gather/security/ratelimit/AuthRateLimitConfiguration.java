package com.example.gather.security.ratelimit;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.core.StringRedisTemplate;

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(AuthRateLimitProperties.class)
public class AuthRateLimitConfiguration {
    @Bean
    @Profile("!redis")
    AuthRateLimitStore memoryAuthRateLimitStore(AuthRateLimitProperties settings) {
        return new MemoryAuthRateLimitStore(settings.maxBuckets());
    }

    @Bean
    @Profile("redis")
    AuthRateLimitStore redisAuthRateLimitStore(AuthRateLimitProperties settings, StringRedisTemplate redis) {
        return new RedisAuthRateLimitStore(redis, settings.namespace(), settings.maxBuckets());
    }
}

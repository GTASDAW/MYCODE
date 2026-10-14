package com.example.gather.security.ratelimit;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import tools.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class AuthRateLimitFilterTest {
    private final ObjectMapper json = new ObjectMapper();
    private final AuthRateLimitProperties settings = new AuthRateLimitProperties(60, 60, 10, 60, 5, 600, 10000, "gather:test", List.of());

    @Test
    void unavailableStoreReturnsSafe503AndNeverInvokesAuthentication() throws Exception {
        var called = new AtomicBoolean();
        var response = new MockHttpServletResponse();
        response.setHeader("X-Request-Id", "server-generated-id");
        var filter = new AuthRateLimitFilter(settings, buckets -> AuthRateLimitStore.Decision.unavailable(), json);
        filter.doFilter(request("POST", "/api/auth/login"), response, (request, result) -> called.set(true));
        assertThat(called).isFalse();
        assertThat(response.getStatus()).isEqualTo(503);
        assertThat(json.readTree(response.getContentAsString()).get("code").asString()).isEqualTo("AUTH_RATE_LIMIT_UNAVAILABLE");
        assertThat(response.getHeader("Retry-After")).isNull();
        assertThat(response.getHeader("X-Request-Id")).isEqualTo("server-generated-id");
    }

    @Test
    void keysAreFixedSizeDigestsAndRegistrationBodyIsNeverRead() throws Exception {
        var login = request("POST", "/api/auth/login");
        login.addParameter("username", "  Secret_User  ");
        AtomicInteger calls = new AtomicInteger();
        var store = (AuthRateLimitStore) buckets -> {
            assertThat(buckets).allSatisfy(bucket -> assertThat(bucket.digest()).matches("[0-9a-f]{64}")
                .doesNotContain("Secret_User", "secret_user", "192.0.2.1"));
            calls.incrementAndGet();
            return AuthRateLimitStore.Decision.allowed();
        };
        var filter = new AuthRateLimitFilter(settings, store, json);
        filter.doFilter(login, new MockHttpServletResponse(), (request, response) -> {});
        var register = request("POST", "/api/auth/register");
        register.setContent("{\"username\":\"Unconsumed\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        filter.doFilter(register, new MockHttpServletResponse(), (request, response) -> {
            assertThat(request.getInputStream().readAllBytes()).asString().contains("Unconsumed");
        });
        assertThat(calls).hasValue(2);
    }

    @Test
    void unrelatedPathsAndMethodsDoNotConsumeLimits() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        var filter = new AuthRateLimitFilter(settings, buckets -> {
            calls.incrementAndGet();
            return AuthRateLimitStore.Decision.allowed();
        }, json);
        for (String path : List.of("/api/auth/logout", "/api/me/profile", "/api/activities/1/registration")) {
            filter.doFilter(request("POST", path), new MockHttpServletResponse(), (request, response) -> {});
        }
        filter.doFilter(request("GET", "/api/auth/login"), new MockHttpServletResponse(), (request, response) -> {});
        assertThat(calls).hasValue(0);
    }

    @Test
    @SuppressWarnings("unchecked")
    void redisExceptionsAndMalformedResultsFailClosedWithoutLocalFallback() {
        var redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class)))
            .thenThrow(new IllegalStateException("redis://private-user:secret-password@private-host"));
        var store = new RedisAuthRateLimitStore(redis, "gather:test", 10);
        var buckets = List.of(new AuthRateLimitStore.Bucket("digest", 1, 1));
        assertThat(store.consume(buckets).outcome()).isEqualTo(AuthRateLimitStore.Outcome.UNAVAILABLE);
        assertThat(store.consume(buckets).outcome()).isEqualTo(AuthRateLimitStore.Outcome.UNAVAILABLE);
        reset(redis);
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class))).thenReturn(List.of(1L, 0L));
        assertThat(store.consume(buckets).outcome()).isEqualTo(AuthRateLimitStore.Outcome.UNAVAILABLE);
        reset(redis);
        when(redis.execute(any(RedisScript.class), anyList(), any(Object[].class))).thenReturn(List.of(0L, 0L));
        assertThat(store.consume(buckets).outcome()).isEqualTo(AuthRateLimitStore.Outcome.ALLOWED);
    }

    private static MockHttpServletRequest request(String method, String path) {
        var request = new MockHttpServletRequest(method, path);
        request.setRemoteAddr("192.0.2.1");
        return request;
    }
}

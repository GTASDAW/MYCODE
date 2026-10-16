package com.example.gather.security.ratelimit;

import com.example.gather.domain.UserRow;
import com.example.gather.security.AppUserDetails;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import tools.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;

class PasswordChangeRateLimitFilterTest {
    private final ObjectMapper json = new ObjectMapper();
    private final AuthRateLimitProperties settings = new AuthRateLimitProperties(60, 60, 10, 60, 5, 600, 5, 600, 20, 600, 10000, "gather:test", List.of());
    @AfterEach void clear() { SecurityContextHolder.clearContext(); }

    @Test
    void twoIdentityBucketsAreDigestedAndRequestBodyIsNotConsumed() throws Exception {
        authenticate(42);
        var filter = new PasswordChangeRateLimitFilter(settings, buckets -> {
            assertThat(buckets).hasSize(2).allSatisfy(bucket -> assertThat(bucket.digest()).matches("[0-9a-f]{64}")
                .doesNotContain("192.0.2.1", "username", "password"));
            assertThat(buckets).extracting(AuthRateLimitStore.Bucket::limit).containsExactly(5, 20);
            return AuthRateLimitStore.Decision.allowed();
        }, json);
        var request = request(); request.setContent("{\"currentPassword\":\"Secret123!\"}".getBytes(StandardCharsets.UTF_8));
        filter.doFilter(request, new MockHttpServletResponse(), (value, response) ->
            assertThat(new String(value.getInputStream().readAllBytes(), StandardCharsets.UTF_8)).contains("Secret123!"));
    }

    @Test
    void quotaFailurePreservesRetryAfterAndDoesNotCallBusinessCode() throws Exception {
        authenticate(42);
        var called = new AtomicBoolean(); var response = new MockHttpServletResponse();
        new PasswordChangeRateLimitFilter(settings, buckets -> AuthRateLimitStore.Decision.limited(11), json)
            .doFilter(request(), response, (request, result) -> called.set(true));
        assertThat(called).isFalse(); assertThat(response.getStatus()).isEqualTo(429);
        assertThat(response.getHeader("Retry-After")).isEqualTo("11");
        assertThat(json.readTree(response.getContentAsString()).get("retryAfterSeconds").asInt()).isEqualTo(11);
    }

    @Test
    void unavailableCounterFailsClosedAndAnonymousCannotSpendAQuota() throws Exception {
        var spent = new AtomicBoolean(); var response = new MockHttpServletResponse();
        var filter = new PasswordChangeRateLimitFilter(settings, buckets -> { spent.set(true); return AuthRateLimitStore.Decision.unavailable(); }, json);
        filter.doFilter(request(), response, (request, result) -> fail("Anonymous cannot change password"));
        assertThat(spent).isFalse(); assertThat(response.getStatus()).isEqualTo(401);
        authenticate(42); response = new MockHttpServletResponse();
        filter.doFilter(request(), response, (request, result) -> fail("Counter failure must not bypass limits"));
        assertThat(response.getStatus()).isEqualTo(503); assertThat(response.getContentAsString()).contains("AUTH_RATE_LIMIT_UNAVAILABLE");
    }

    @Test
    void accountBucketIsSharedAcrossSourcesAndSourceBucketAcrossAccounts() throws Exception {
        var captured = new AtomicReference<List<AuthRateLimitStore.Bucket>>();
        var filter = new PasswordChangeRateLimitFilter(settings, buckets -> { captured.set(buckets); return AuthRateLimitStore.Decision.allowed(); }, json);
        authenticate(42); filter.doFilter(request(), new MockHttpServletResponse(), (request, result) -> {});
        var first = captured.get();
        var differentSource = request(); differentSource.setRemoteAddr("192.0.2.2");
        filter.doFilter(differentSource, new MockHttpServletResponse(), (request, result) -> {});
        assertThat(captured.get().getFirst().digest()).isEqualTo(first.getFirst().digest());
        assertThat(captured.get().getLast().digest()).isNotEqualTo(first.getLast().digest());
        authenticate(43); filter.doFilter(request(), new MockHttpServletResponse(), (request, result) -> {});
        assertThat(captured.get().getFirst().digest()).isNotEqualTo(first.getFirst().digest());
        assertThat(captured.get().getLast().digest()).isEqualTo(first.getLast().digest());
    }

    private static void authenticate(long id) {
        var principal = new AppUserDetails(new UserRow(id, "username", "hash", "测试", "USER", 0));
        SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities()));
    }
    private static MockHttpServletRequest request() { var request = new MockHttpServletRequest("POST", "/api/me/%70assword"); request.setRemoteAddr("192.0.2.1"); return request; }
}

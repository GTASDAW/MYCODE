package com.example.gather;

import com.example.gather.mapper.UserMapper;
import com.example.gather.security.ratelimit.AuthRateLimitFilter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Strict small limits through the real Spring Security chain and dedicated MySQL. */
@SpringBootTest(properties = {
    "app.auth-rate-limit.login-source-limit=12", "app.auth-rate-limit.login-source-window-seconds=30",
    "app.auth-rate-limit.login-pair-limit=3", "app.auth-rate-limit.login-pair-window-seconds=30",
    "app.auth-rate-limit.register-source-limit=2", "app.auth-rate-limit.register-source-window-seconds=2",
    "app.auth-rate-limit.max-buckets=1000", "app.auth-rate-limit.trusted-proxy-ips=127.0.0.1",
    "spring.datasource.hikari.maximum-pool-size=4"
})
@AutoConfigureMockMvc
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ExtendWith(OutputCaptureExtension.class)
class AuthRateLimitIntegrationTest {
    private static final AtomicInteger SOURCES = new AtomicInteger(1);
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath())) {
            throw new IllegalStateException("TEST_DB_URL must identify dedicated REAL MySQL activity_platform_test");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }
    private static String environment(String key, String fallback) {
        return System.getenv(key) == null ? fallback : System.getenv(key);
    }

    @Autowired MockMvc mvc;
    @Autowired UserMapper users;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired TransactionTemplate transaction;
    @Autowired FilterChainProxy security;
    private final Set<String> ownedUsernames = new LinkedHashSet<>();

    @BeforeEach
    void databaseIdentity() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", String.class)).isEqualTo("10");
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image FROM activities LIMIT 0");
        jdbc.queryForList("SELECT id, activity_id, actor_user_id, registration_id, changes_json FROM activity_audit_logs LIMIT 0");
    }

    @AfterEach
    void cleanupExactUnreferencedAccounts() {
        transaction.executeWithoutResult(status -> {
            for (String username : ownedUsernames) {
                var row = users.findByUsername(username);
                if (row == null) continue;
                assertThat(row.role()).isEqualTo("USER");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE user_id=? OR checked_in_by=?", Integer.class, row.id(), row.id())).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE user_id=?", Integer.class, row.id())).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE created_by=? OR cancelled_by=?", Integer.class, row.id(), row.id())).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE actor_user_id=?", Integer.class, row.id())).isZero();
                jdbc.update("DELETE FROM users WHERE id=? AND username=? AND role='USER'", row.id(), username);
            }
        });
    }

    @Test
    void csrfRejectionNeverCountsAndFilterHasOneCorrectSecurityPosition() throws Exception {
        List<?> filters = security.getFilters("/api/auth/login");
        int csrfIndex = index(filters, CsrfFilter.class);
        int rateIndex = index(filters, AuthRateLimitFilter.class);
        int authenticationIndex = index(filters, UsernamePasswordAuthenticationFilter.class);
        assertThat(csrfIndex).isLessThan(rateIndex);
        assertThat(rateIndex).isLessThan(authenticationIndex);
        assertThat(filters.stream().filter(AuthRateLimitFilter.class::isInstance).count()).isEqualTo(1);
        String source = source();
        for (int attempt = 0; attempt < 10; attempt++) {
            mvc.perform(at(post("/api/auth/login").param("username", "demo").param("password", "wrong"), source))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        }
        for (int attempt = 0; attempt < 3; attempt++) failure(source, "demo");
        limited(login(source, "demo", "Demo123!"));
        mvc.perform(at(get("/api/auth/csrf"), source)).andExpect(status().isOk());
    }

    @Test
    void successfulLoginConsumesLimitAndSuccessNeverResetsIt(CapturedOutput output) throws Exception {
        String source = source();
        var success = mvc.perform(login(source, "demo", "Demo123!"))
            .andExpect(status().isOk()).andReturn();
        assertThat(success.getRequest().getSession(false)).isNotNull();
        failure(source, "demo");
        failure(source, " DEMO ");
        var denied = limited(login(source, "demo", "Demo123!"));
        assertThat(denied.getRequest().getSession(false)).isNull();
        assertThat(output.getAll()).doesNotContain("Demo123!", " DEMO ", source);
        assertThat(output.getAll()).contains("/api/auth/login", "429");
    }

    @Test
    void normalizedUsernameSharesPairButDifferentSourceDoesNotLockWholeAccount() throws Exception {
        String source = source();
        failure(source, "MiXeD_User");
        failure(source, " mixed_user ");
        failure(source, "MIXED_USER");
        limited(login(source, "mixed_user", "wrong"));
        failure(source(), "mixed_user");
    }

    @Test
    void databaseCollationAliasesCannotAuthenticateInAnotherPairBucket() throws Exception {
        assertThat(users.findByUsername("démó").username()).isEqualTo("demo");
        String source = source();
        for (int attempt = 0; attempt < 3; attempt++) failure(source, "demo");
        limited(login(source, " DEMO ", "Demo123!"));
        for (String alias : List.of("démó", "ｄｅｍｏ", "de\u0301mo")) {
            var denied = mvc.perform(login(source, alias, "Demo123!"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"))
                .andReturn();
            assertThat(denied.getRequest().getSession(false)).isNull();
        }
        mvc.perform(login(source(), " DEMO ", "Demo123!"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.username").value("demo"));
    }

    @Test
    void rotatingUsernamesCannotBypassSourceLimitAndRejectedPairDoesNotSpendSource() throws Exception {
        String source = source();
        for (int attempt = 0; attempt < 3; attempt++) failure(source, "first");
        for (int attempt = 0; attempt < 5; attempt++) limited(login(source, "first", "wrong"));
        for (int attempt = 0; attempt < 9; attempt++) failure(source, "other_" + attempt);
        limited(login(source, "last", "wrong"));
    }

    @Test
    void forgedForwardedAndDedicatedHeadersFromUntrustedPeerCannotRotateIdentity() throws Exception {
        String source = source();
        for (int attempt = 0; attempt < 3; attempt++) {
            mvc.perform(login(source, "demo", "wrong").header("X-Forwarded-For", "198.51.100." + attempt)
                    .header("Forwarded", "for=198.51.100." + attempt).header("X-Gather-Client-IP", "198.51.100." + attempt))
                .andExpect(status().isUnauthorized());
        }
        limited(login(source, "demo", "wrong").header("X-Gather-Client-IP", "203.0.113.30"));
    }

    @Test
    void trustedProxyUsesOnlyDedicatedCanonicalAddressAndIgnoresOrdinaryForwardingHeaders() throws Exception {
        String peer = "127.0.0.1";
        String client = "2001:db8::" + Integer.toHexString(SOURCES.incrementAndGet());
        for (int attempt = 0; attempt < 3; attempt++) {
            mvc.perform(login(peer, "demo", "wrong").header("X-Gather-Client-IP", client)
                    .header("X-Forwarded-For", "198.51.100." + attempt)).andExpect(status().isUnauthorized());
        }
        limited(login(peer, "demo", "wrong").header("X-Gather-Client-IP", client.toUpperCase(Locale.ROOT)));
        failure(source(), "demo");
    }

    @Test
    void registration429DoesNotWriteOrAuthenticateAndPreservesJsonAndRequestId(CapturedOutput output) throws Exception {
        String source = source();
        for (int attempt = 0; attempt < 2; attempt++) {
            mvc.perform(register(source, newUsername())).andExpect(status().isCreated());
        }
        String rejected = newUsername();
        var denied = limited(register(source, rejected));
        assertThat(users.findByUsername(rejected)).isNull();
        assertThat(denied.getRequest().getSession(false)).isNull();
        assertThat(output.getAll()).doesNotContain("Limit123!", rejected, source);
        assertThat(output.getAll()).contains("/api/auth/register", "429");
    }

    @Test
    void csrfInvalidRegistrationDoesNotCountButMalformedBodiesDo() throws Exception {
        String source = source();
        for (int attempt = 0; attempt < 5; attempt++) {
            mvc.perform(at(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content("{bad"), source))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        }
        for (int attempt = 0; attempt < 2; attempt++) {
            mvc.perform(at(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{bad"), source))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        limited(register(source, newUsername()));
    }

    @Test
    void registrationWindowExpiresWithoutBlockedRequestsExtendingIt() throws Exception {
        String source = source();
        var invalid = at(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"), source);
        mvc.perform(invalid).andExpect(status().isBadRequest());
        mvc.perform(invalid).andExpect(status().isBadRequest());
        limited(invalid);
        Thread.sleep(2100);
        mvc.perform(invalid).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    @Test
    void concurrentLoginRequestsHaveExactlyThreeQualifiedAttempts() throws Exception {
        String source = source();
        var start = new CountDownLatch(1);
        List<Future<MvcResult>> results = new ArrayList<>();
        try (var workers = Executors.newFixedThreadPool(20)) {
            for (int index = 0; index < 40; index++) results.add(workers.submit(() -> {
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("barrier timed out");
                return mvc.perform(login(source, "concurrent_unknown", "wrong")).andReturn();
            }));
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (var result : results) statuses.add(result.get(30, TimeUnit.SECONDS).getResponse().getStatus());
            assertThat(statuses.stream().filter(value -> value == 401).count()).isEqualTo(3);
            assertThat(statuses.stream().filter(value -> value == 429).count()).isEqualTo(37);
        }
    }

    @Test
    void encodedRouteAliasesShareCanonicalLimitsAndCannotBypassSecurityMatching() throws Exception {
        String loginSource = source();
        mvc.perform(at(post(URI.create("/api/auth/%6cogin")).with(csrf()).param("username", "demo").param("password", "wrong"), loginSource))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
        failure(loginSource, "demo");
        failure(loginSource, "demo");
        limited(at(post(URI.create("/api/auth/%6cogin")).with(csrf()).param("username", "demo").param("password", "Demo123!"), loginSource));
        String registerSource = source();
        mvc.perform(at(post(URI.create("/api/auth/%72egister")).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"), registerSource))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        mvc.perform(at(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"), registerSource))
            .andExpect(status().isBadRequest());
        limited(at(post(URI.create("/api/auth/%72egister")).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"), registerSource));
    }

    private static int index(List<?> filters, Class<?> type) {
        for (int index = 0; index < filters.size(); index++) if (type.isInstance(filters.get(index))) return index;
        throw new AssertionError("Missing security filter: " + type.getSimpleName());
    }
    private static String source() { return "192.0.2." + SOURCES.incrementAndGet(); }
    private static MockHttpServletRequestBuilder at(MockHttpServletRequestBuilder request, String source) {
        return request.with(value -> { value.setRemoteAddr(source); return value; });
    }
    private static MockHttpServletRequestBuilder login(String source, String username, String password) {
        return at(post("/api/auth/login").with(csrf()).contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .param("username", username).param("password", password), source);
    }
    private void failure(String source, String username) throws Exception {
        mvc.perform(login(source, username, "wrong")).andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
    }
    private MvcResult limited(MockHttpServletRequestBuilder request) throws Exception {
        MvcResult result = mvc.perform(request).andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.code").value("AUTH_RATE_LIMITED")).andReturn();
        long retry = json.readTree(result.getResponse().getContentAsString()).get("retryAfterSeconds").asLong();
        assertThat(retry).isPositive();
        assertThat(result.getResponse().getHeader("Retry-After")).isEqualTo(Long.toString(retry));
        assertThat(UUID.fromString(result.getResponse().getHeader("X-Request-Id"))).isNotNull();
        return result;
    }
    private String newUsername() {
        String username = "l" + UUID.randomUUID().toString().replace("-", "").substring(0, 31);
        assertThat(users.findByUsername(username)).isNull();
        ownedUsernames.add(username);
        return username;
    }
    private MockHttpServletRequestBuilder register(String source, String username) throws Exception {
        return at(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("username", username, "password", "Limit123!", "displayName", "限流回归样例"))), source);
    }
}

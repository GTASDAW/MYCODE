package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.PasswordModels.ChangePasswordRequest;
import com.example.gather.mapper.UserMapper;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.domain.NewActivity;
import com.example.gather.security.AppUserDetails;
import com.example.gather.security.CredentialVersionFilter;
import com.example.gather.security.CurrentSessionLogout;
import com.example.gather.security.ratelimit.AuthRateLimitFilter;
import com.example.gather.security.ratelimit.PasswordChangeRateLimitFilter;
import com.example.gather.service.PasswordChangeService;
import com.example.gather.support.OwnedIntegrationFixtures;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.FilterChainProxy;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.csrf.CsrfFilter;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Dedicated MySQL, real BCrypt, Security chain, CAS and Session boundary evidence. */
@SpringBootTest(properties = {"spring.datasource.hikari.maximum-pool-size=4",
    "app.auth-rate-limit.password-account-limit=3", "app.auth-rate-limit.password-account-window-seconds=60",
    "app.auth-rate-limit.password-source-limit=12", "app.auth-rate-limit.password-source-window-seconds=60"})
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(PasswordChangeIntegrationTest.Configuration.class)
@ExtendWith(OutputCaptureExtension.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class PasswordChangeIntegrationTest {
    private static final String PASSWORD = "Original123!";
    private static final String NEXT = "NextPassword456!";
    private static final String PATH = "/api/me/password";
    private static final String USER_LOOKUP = "com.example.gather.mapper.UserMapper.findById";
    private static final String LOGIN_LOOKUP = "com.example.gather.mapper.UserMapper.findByUsername";
    private static final String UPDATE = "com.example.gather.mapper.UserMapper.changePassword";
    private static final String VERSION = "com.example.gather.mapper.CredentialVersionMapper.findByUserId";
    private static final AtomicInteger SOURCES = new AtomicInteger();

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration { @Bean PasswordInterceptor passwordInterceptor() { return new PasswordInterceptor(); } }
    record Hook(String statement, boolean before, Runnable action) {}
    record Read(String id, String sql) {}
    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class PasswordInterceptor implements Interceptor {
        final AtomicReference<Hook> hook = new AtomicReference<>();
        final AtomicBoolean versionFailure = new AtomicBoolean();
        final AtomicBoolean failAfterUpdate = new AtomicBoolean();
        final ThreadLocal<List<Read>> reads = new ThreadLocal<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0]; String id = statement.getId();
            if (id.equals(VERSION) && versionFailure.get()) throw new DataAccessResourceFailureException("password-test-private-db-password");
            if (reads.get() != null && statement.getSqlCommandType() == org.apache.ibatis.mapping.SqlCommandType.SELECT)
                reads.get().add(new Read(id, statement.getBoundSql(invocation.getArgs()[1]).getSql()));
            Hook next = hook.get(); boolean run = next != null && next.statement().equals(id) && hook.compareAndSet(next, null);
            if (run && next.before()) next.action().run();
            Object result = invocation.proceed();
            if (id.equals(UPDATE) && failAfterUpdate.getAndSet(false)) throw new DataAccessResourceFailureException("password-test-private-update-failed");
            if (run && !next.before()) next.action().run();
            return result;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Password tests require dedicated REAL activity_platform_test MySQL");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!"); properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }
    private static String environment(String key, String fallback) { return System.getenv(key) == null ? fallback : System.getenv(key); }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityMapper activities;
    @Autowired PasswordEncoder encoder;
    @Autowired PasswordChangeService passwords;
    @Autowired PasswordInterceptor hooks;
    @Autowired FilterChainProxy security;
    @Autowired ObjectMapper json;
    @MockitoSpyBean CurrentSessionLogout sessions;
    private final Map<Long, String> ownedUsers = new LinkedHashMap<>();
    private final List<Long> ownedActivities = new ArrayList<>();

    @BeforeEach void verifyDatabase() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(8);
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category FROM activities LIMIT 0");
    }
    @AfterEach void cleanExactFixtures() {
        hooks.hook.set(null); hooks.reads.remove(); hooks.versionFailure.set(false); hooks.failAfterUpdate.set(false); reset(sessions);
        ownedUsers.forEach((id, name) -> assertThat(users.findById(id).username()).isEqualTo(name));
        OwnedIntegrationFixtures.remove(jdbc, ownedActivities, ownedUsers.keySet());
    }

    @Test void filterOrderAndCsrfPermissionChecksPrecedePasswordQuotaAndBody() throws Exception {
        var filters = security.getFilters(PATH);
        assertThat(index(filters, CsrfFilter.class)).isLessThan(index(filters, AuthRateLimitFilter.class));
        assertThat(index(filters, UsernamePasswordAuthenticationFilter.class)).isLessThan(index(filters, CredentialVersionFilter.class));
        assertThat(index(filters, CredentialVersionFilter.class)).isLessThan(index(filters, AuthorizationFilter.class));
        assertThat(index(filters, AuthorizationFilter.class)).isLessThan(index(filters, PasswordChangeRateLimitFilter.class));
        assertThat(filters.stream().filter(CredentialVersionFilter.class::isInstance).count()).isEqualTo(1);
        assertThat(filters.stream().filter(PasswordChangeRateLimitFilter.class::isInstance).count()).isEqualTo(1);
        mvc.perform(post(PATH).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        long id = createUser("USER", PASSWORD); var principal = principal(id);
        for (int attempt = 0; attempt < 6; attempt++) mvc.perform(post(PATH).with(user(principal)).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        for (int attempt = 0; attempt < 3; attempt++) mvc.perform(change(principal, "", NEXT)).andExpect(status().isBadRequest());
        limited(change(principal, "", NEXT));
    }

    @Test void userAndAdminCanChangeOnlyTheirOwnPasswordAndSuccessLogsOutCurrentSession(CapturedOutput output) throws Exception {
        for (String role : List.of("USER", "ADMIN")) {
            long id = createUser(role, PASSWORD); long other = createUser("USER", PASSWORD);
            var before = users.findById(id); var otherBefore = accountState(other);
            var session = login(id, PASSWORD);
            String originalSessionId = session.getId();
            var admittedContext = (org.springframework.security.core.context.SecurityContext) session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
            var admittedAuthentication = admittedContext.getAuthentication();
            var response = mvc.perform(at(post(PATH).session(session).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("currentPassword", PASSWORD, "newPassword", NEXT, "userId", other, "id", other, "role", "ADMIN"))), source()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.success").value(true)).andReturn().getResponse();
            assertAnonymousSession(session);
            assertThat(admittedContext.getAuthentication() == admittedAuthentication)
                .as("Already admitted requests retain their original authentication object").isTrue();
            assertThat(response.getHeaders("Set-Cookie").stream().noneMatch(value -> value.contains("JSESSIONID=") && value.contains("Max-Age=0")))
                .as("Password change must not send a session cookie deletion").isTrue();
            var after = users.findById(id);
            assertThat(after.credentialVersion()).isEqualTo(before.credentialVersion() + 1);
            assertThat(after.passwordHash().equals(before.passwordHash())).isFalse(); assertThat(encoder.matches(NEXT, after.passwordHash())).isTrue();
            assertThat(after.username()).isEqualTo(before.username()); assertThat(after.displayName()).isEqualTo(before.displayName()); assertThat(after.role()).isEqualTo(role);
            assertThat(accountState(other)).isEqualTo(otherBefore);
            mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
            var loggedInAgain = mvc.perform(at(post("/api/auth/login").session(session).with(csrf())
                .param("username", ownedUsers.get(id)).param("password", NEXT), source())).andExpect(status().isOk()).andReturn();
            assertThat(loggedInAgain.getRequest().getSession(false).getId().equals(originalSessionId))
                .as("Reauthentication rotates the retained anonymous session ID").isFalse();
            mvc.perform(at(post("/api/auth/login").with(csrf()).param("username", ownedUsers.get(id)).param("password", PASSWORD), source()))
                .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
            assertSafeOutput(output, PASSWORD, NEXT, after.passwordHash());
        }
    }

    @Test void wrongCurrentSameAndInvalidNewPasswordsPreserveHashAndVersion() throws Exception {
        for (var entry : List.of(Map.entry("wrong", "CURRENT_PASSWORD_INCORRECT"), Map.entry(PASSWORD, "PASSWORD_UNCHANGED"))) {
            long id = createUser("USER", PASSWORD); var before = accountState(id);
            mvc.perform(change(principal(id), entry.getKey(), PASSWORD)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value(entry.getValue()));
            assertThat(accountState(id)).isEqualTo(before);
        }
        for (String invalid : List.of("Ab12345", "a1" + "x".repeat(63), "abcdefgh", "12345678", "a1" + "汉".repeat(24))) {
            long id = createUser("USER", PASSWORD); var before = accountState(id);
            mvc.perform(change(principal(id), PASSWORD, invalid)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            assertThat(accountState(id)).isEqualTo(before);
        }
    }

    @Test void missingMalformedBodiesAndOldPasswordByteLimitFailWithoutWriting() throws Exception {
        for (String body : List.of("{}", "null", "[]", "{broken", "{\"newPassword\":\"NextPassword456!\"}")) {
            long id = createUser("USER", PASSWORD); var before = accountState(id);
            mvc.perform(at(post(PATH).with(user(principal(id))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body), source()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            assertThat(accountState(id)).isEqualTo(before);
        }
        long id = createUser("USER", PASSWORD); var before = accountState(id);
        mvc.perform(change(principal(id), "汉".repeat(25), NEXT)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        assertThat(accountState(id)).isEqualTo(before);
    }

    @Test void legacyCurrentPasswordNeedNotMeetNewPolicyAndWhitespaceIsNeverTrimmed() throws Exception {
        long legacy = createUser("USER", " x ");
        mvc.perform(change(principal(legacy), "x", NEXT)).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("CURRENT_PASSWORD_INCORRECT"));
        mvc.perform(change(principal(legacy), " x ", " Ab12345 ")).andExpect(status().isOk());
        assertThat(encoder.matches(" Ab12345 ", users.findById(legacy).passwordHash())).isTrue();
        assertThat(encoder.matches("Ab12345", users.findById(legacy).passwordHash())).isFalse();
        long unicode = createUser("USER", PASSWORD);
        String exactBytes = "a1" + "汉".repeat(23) + "b";
        assertThat(exactBytes.getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isEqualTo(72);
        mvc.perform(change(principal(unicode), PASSWORD, exactBytes)).andExpect(status().isOk());
        login(unicode, exactBytes);
    }

    @Test void oldSessionsLoseProtectedIdentityButPublicDiscoveryContinuesAnonymously() throws Exception {
        long id = createUser("USER", PASSWORD); var first = login(id, PASSWORD); var second = login(id, PASSWORD); var publicSession = login(id, PASSWORD);
        var activity = new NewActivity("Password public " + UUID.randomUUID(), "密码会话独立初始化样例", "测试地点",
            java.time.LocalDateTime.ofInstant(java.time.Instant.now().plusSeconds(3600), java.time.ZoneOffset.UTC), 1, users.findByUsername("admin").id());
        activities.insert(activity); ownedActivities.add(activity.id);
        jdbc.update("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,'ACTIVE')", activity.id, id);
        jdbc.update("UPDATE activities SET registered_count=1 WHERE id=?", activity.id);
        passwords.change(principal(id), new ChangePasswordRequest(PASSWORD, NEXT));
        mvc.perform(get("/api/auth/me").session(first)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        assertAnonymousSession(first);
        mvc.perform(get("/api/me/registrations").session(second)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        mvc.perform(get("/api/activities/" + activity.id).session(publicSession)).andExpect(status().isOk())
            .andExpect(jsonPath("$.registrationStatus").value(org.hamcrest.Matchers.nullValue()));
        assertAnonymousSession(publicSession);
    }

    @Test void legacySerializedNullVersionSessionCannotEnterProtectedBusinessCode() throws Exception {
        long id = createUser("USER", PASSWORD); var old = principal(id);
        Field version = AppUserDetails.class.getDeclaredField("credentialVersion"); version.setAccessible(true); version.set(old, null);
        old.eraseCredentials();
        var authentication = UsernamePasswordAuthenticationToken.authenticated(old, null, old.getAuthorities());
        var session = new MockHttpSession();
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, new SecurityContextImpl(authentication));
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        assertAnonymousSession(session); assertThat(users.findById(id).credentialVersion()).isZero();
    }

    @Test void staleSessionCsrfReadReturnsRevokedWithoutCookieAndExplicitAnonymousReadCreatesFreshToken() throws Exception {
        long id = createUser("USER", PASSWORD); var session = login(id, PASSWORD);
        var token = json.readTree(mvc.perform(get("/api/auth/csrf").session(session)).andReturn().getResponse().getContentAsString());
        passwords.change(principal(id), new ChangePasswordRequest(PASSWORD, NEXT));
        var revoked = mvc.perform(get("/api/auth/csrf").session(session)).andExpect(status().isUnauthorized())
            .andExpect(jsonPath("$.code").value("SESSION_REVOKED")).andReturn();
        assertThat(revoked.getRequest().getSession(false) == session).as("Revoked CSRF read retains only the existing anonymous session").isTrue();
        assertAnonymousSession(session);
        assertThat(revoked.getResponse().getHeaders("Set-Cookie").isEmpty()).as("Revoked CSRF read must not set any cookie").isTrue();
        var refreshed = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        var next = json.readTree(refreshed.getResponse().getContentAsString());
        assertThat(next.get("token").asString().equals(token.get("token").asString()))
            .as("Fresh anonymous CSRF token must differ from the revoked token").isFalse();
        var anonymous = (MockHttpSession) refreshed.getRequest().getSession(false);
        assertThat(anonymous.getId().equals(session.getId())).as("Anonymous session must differ from the revoked session").isFalse();
        mvc.perform(post(PATH).session(anonymous).header(token.get("headerName").asString(), token.get("token").asString())
            .contentType(MediaType.APPLICATION_JSON).content(body(NEXT, "Another789!"))).andExpect(status().isForbidden());
        mvc.perform(post(PATH).session(anonymous).header(next.get("headerName").asString(), next.get("token").asString())
            .contentType(MediaType.APPLICATION_JSON).content(body(NEXT, "Another789!"))).andExpect(status().isUnauthorized());
    }

    @Test void authenticatedReadsAddExactlyOneVersionOnlySelectAndDatabaseFailureFailsClosed(CapturedOutput output) throws Exception {
        long id = createUser("USER", PASSWORD); var principal = principal(id);
        List<Read> queries = new ArrayList<>(); hooks.reads.set(queries);
        try { mvc.perform(get("/api/auth/me").with(user(principal))).andExpect(status().isOk()); }
        finally { hooks.reads.remove(); }
        assertThat(queries.stream().filter(read -> read.id().equals(VERSION))).singleElement().satisfies(read ->
            assertThat(read.sql().toLowerCase(Locale.ROOT)).contains("credential_version").doesNotContain("password_hash", "for update"));
        assertThat(queries.stream().filter(read -> read.id().equals(USER_LOOKUP)).count()).isEqualTo(1);
        hooks.versionFailure.set(true);
        mvc.perform(get("/api/auth/me").with(user(principal))).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("AUTHENTICATION_UNAVAILABLE"));
        mvc.perform(get("/api/activities/search").with(user(principal))).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("AUTHENTICATION_UNAVAILABLE"));
        assertSafeOutput(output, "password-test-private-db-password");
    }

    @Test void passwordCasAllowsExactlyOneConcurrentWinnerAndHasNoLockingRead() throws Exception {
        long id = createUser("USER", PASSWORD); var principal = principal(id);
        var afterFirstRead = new CountDownLatch(1); var releaseFirst = new CountDownLatch(1);
        hooks.hook.set(new Hook(USER_LOOKUP, false, () -> { afterFirstRead.countDown(); await(releaseFirst); }));
        try (var workers = Executors.newFixedThreadPool(2)) {
            Future<String> first = workers.submit(() -> outcome(() -> passwords.change(principal, new ChangePasswordRequest(PASSWORD, NEXT))));
            assertThat(afterFirstRead.await(10, TimeUnit.SECONDS)).isTrue();
            Future<String> second = workers.submit(() -> outcome(() -> passwords.change(principal, new ChangePasswordRequest(PASSWORD, "OtherPassword789!"))));
            assertThat(second.get(20, TimeUnit.SECONDS)).isEqualTo("success");
            releaseFirst.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo("SESSION_REVOKED");
        } finally { releaseFirst.countDown(); }
        var row = users.findById(id); assertThat(row.credentialVersion()).isEqualTo(1);
        assertThat(encoder.matches("OtherPassword789!", row.passwordHash())).isTrue();
    }

    @Test void unexpectedWriteFailureRollsBackHashAndVersionAndDoesNotLeakSecrets(CapturedOutput output) throws Exception {
        long id = createUser("USER", PASSWORD); var before = accountState(id); hooks.failAfterUpdate.set(true);
        mvc.perform(change(principal(id), PASSWORD, NEXT)).andExpect(status().isInternalServerError());
        assertThat(accountState(id)).isEqualTo(before);
        assertSafeOutput(output, PASSWORD, NEXT, "password-test-private-update-failed");
    }

    @Test void oldHashLoginFinishingAfterPasswordChangeKeepsOldVersionAndIsRejectedOnNextRequest() throws Exception {
        long id = createUser("USER", PASSWORD); var oldPrincipal = principal(id);
        var loadedOldHash = new CountDownLatch(1); var resumeLogin = new CountDownLatch(1);
        hooks.hook.set(new Hook(LOGIN_LOOKUP, false, () -> { loadedOldHash.countDown(); await(resumeLogin); }));
        try (var worker = Executors.newSingleThreadExecutor()) {
            Future<MvcResult> late = worker.submit(() -> mvc.perform(at(post("/api/auth/login").with(csrf())
                .param("username", ownedUsers.get(id)).param("password", PASSWORD), source())).andReturn());
            assertThat(loadedOldHash.await(10, TimeUnit.SECONDS)).isTrue();
            passwords.change(oldPrincipal, new ChangePasswordRequest(PASSWORD, NEXT));
            resumeLogin.countDown();
            var response = late.get(20, TimeUnit.SECONDS); assertThat(response.getResponse().getStatus()).isEqualTo(200);
            var session = (MockHttpSession) response.getRequest().getSession(false);
            var context = (org.springframework.security.core.context.SecurityContext) session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
            assertThat(((AppUserDetails) context.getAuthentication().getPrincipal()).credentialVersion()).isZero();
            mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        } finally { resumeLogin.countDown(); }
    }

    @Test void alreadyAuthenticatedInflightReadCanCompleteButLateSessionSaveCannotRestoreIdentity() throws Exception {
        long id = createUser("USER", PASSWORD); var oldPrincipal = principal(id); var session = login(id, PASSWORD);
        var versionChecked = new CountDownLatch(1); var resume = new CountDownLatch(1);
        hooks.hook.set(new Hook(VERSION, false, () -> { versionChecked.countDown(); await(resume); }));
        try (var worker = Executors.newSingleThreadExecutor()) {
            Future<MvcResult> inflight = worker.submit(() -> mvc.perform(get("/api/auth/me").session(session)).andReturn());
            assertThat(versionChecked.await(10, TimeUnit.SECONDS)).isTrue();
            passwords.change(oldPrincipal, new ChangePasswordRequest(PASSWORD, NEXT));
            resume.countDown(); assertThat(inflight.get(20, TimeUnit.SECONDS).getResponse().getStatus()).isEqualTo(200);
        } finally { resume.countDown(); }
        var oldAuthentication = UsernamePasswordAuthenticationToken.authenticated(oldPrincipal, null, oldPrincipal.getAuthorities());
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, new SecurityContextImpl(oldAuthentication));
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
    }

    @Test void successfulCommitWithLogoutFailureReturnsUnconfirmedAndOldSessionStillCannotReauthenticate(CapturedOutput output) throws Exception {
        long id = createUser("USER", PASSWORD); var session = login(id, PASSWORD);
        doThrow(new IllegalStateException("private-session-store-password")).when(sessions).logout(any(), any(), any());
        mvc.perform(at(post(PATH).session(session).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body(PASSWORD, NEXT)), source()))
            .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("PASSWORD_CHANGE_UNCONFIRMED"));
        assertThat(users.findById(id).credentialVersion()).isEqualTo(1);
        assertThat(encoder.matches(NEXT, users.findById(id).passwordHash())).isTrue();
        reset(sessions);
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        login(id, NEXT);
        assertSafeOutput(output, "private-session-store-password", PASSWORD, NEXT);
    }

    @Test void passwordQuotaSharesAccountsAcrossSessionsAndSourcesAndRejectsBeforeReadingBody() throws Exception {
        long id = createUser("USER", PASSWORD); var principal = principal(id);
        for (int attempt = 0; attempt < 3; attempt++) mvc.perform(at(post(URI.create("/api/me/%70assword")).with(user(principal)).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content("{}"), source())).andExpect(status().isBadRequest());
        limited(change(principal, PASSWORD, NEXT));
        assertThat(users.findById(id).credentialVersion()).isZero();
        String sharedSource = source();
        for (int attempt = 0; attempt < 12; attempt++) {
            long other = createUser("USER", PASSWORD);
            mvc.perform(at(post(PATH).with(user(principal(other))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"), sharedSource))
                .andExpect(status().isBadRequest());
        }
        long blocked = createUser("USER", PASSWORD);
        limited(at(post(PATH).with(user(principal(blocked))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body(PASSWORD, NEXT)), sharedSource));
        assertThat(users.findById(blocked).credentialVersion()).isZero();
    }

    @Test void revokedSessionDoesNotConsumePasswordQuotaAndCurrentVersionCannotUseOldPasswordSnapshot() throws Exception {
        long id = createUser("USER", PASSWORD); var oldPrincipal = principal(id);
        passwords.change(oldPrincipal, new ChangePasswordRequest(PASSWORD, NEXT));
        for (int index = 0; index < 5; index++) mvc.perform(change(oldPrincipal, PASSWORD, "Again789!"))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        var current = principal(id);
        mvc.perform(change(current, PASSWORD, "Again789!")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("CURRENT_PASSWORD_INCORRECT"));
        mvc.perform(change(current, NEXT, "Again789!")).andExpect(status().isOk());
        assertThat(users.findById(id).credentialVersion()).isEqualTo(2);
    }

    private long createUser(String role, String password) {
        String username = "pwd_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, encoder.encode(password), "密码验证样例", role);
        long id = users.findByUsername(username).id(); ownedUsers.put(id, username); return id;
    }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static void assertAnonymousSession(MockHttpSession session) {
        assertThat(session.isInvalid()).as("Logical revocation retains the anonymous HTTP session").isFalse();
        assertThat(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY) == null)
            .as("Revoked session must not retain a server security context").isTrue();
        var request = new MockHttpServletRequest(); request.setSession(session);
        assertThat(new HttpSessionCsrfTokenRepository().loadToken(request) == null)
            .as("Revoked session must not retain the previous CSRF token").isTrue();
    }
    private static void assertSafeOutput(CapturedOutput output, String... secrets) {
        String captured = output.getAll();
        assertThat(Arrays.stream(secrets).noneMatch(captured::contains))
            .as("Captured logs must not contain credentials or raw private failure text").isTrue();
    }
    private String accountState(long id) {
        try {
            return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(json.writeValueAsBytes(users.findById(id))));
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 unavailable", impossible); }
    }
    private MockHttpSession login(long id, String password) throws Exception {
        var response = mvc.perform(at(post("/api/auth/login").with(csrf()).param("username", ownedUsers.get(id)).param("password", password), source()))
            .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) response.getRequest().getSession(false);
    }
    private MockHttpServletRequestBuilder change(AppUserDetails principal, String current, String next) throws Exception {
        return at(post(PATH).with(user(principal)).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body(current, next)), source());
    }
    private String body(String current, String next) { return json.writeValueAsString(Map.of("currentPassword", current, "newPassword", next)); }
    private static MockHttpServletRequestBuilder at(MockHttpServletRequestBuilder request, String source) {
        return request.with(value -> { value.setRemoteAddr(source); return value; });
    }
    private static String source() { int value = SOURCES.incrementAndGet(); return "192.0." + (value / 250) + "." + (value % 250 + 1); }
    private void limited(MockHttpServletRequestBuilder request) throws Exception {
        var response = mvc.perform(request).andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("AUTH_RATE_LIMITED"))
            .andReturn().getResponse();
        assertThat(response.getHeader("Retry-After")).isEqualTo(json.readTree(response.getContentAsString()).get("retryAfterSeconds").asString());
        assertThat(Integer.parseInt(response.getHeader("Retry-After"))).isPositive();
    }
    private static int index(List<?> filters, Class<?> type) {
        for (int index = 0; index < filters.size(); index++) if (type.isInstance(filters.get(index))) return index;
        throw new AssertionError("Missing filter " + type.getSimpleName());
    }
    private static String outcome(Runnable action) { try { action.run(); return "success"; } catch (ApiException failure) { return failure.code(); } }
    private static void await(CountDownLatch latch) {
        try { if (!latch.await(15, TimeUnit.SECONDS)) throw new IllegalStateException("Password test barrier timed out"); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException("Password barrier interrupted", interrupted); }
    }
}

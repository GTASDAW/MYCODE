package com.example.gather;

import com.example.gather.api.ApiModels.CreateActivityRequest;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
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
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.Instant;
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
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** New accounts and activities belong only to this run in the dedicated real MySQL database. */
@SpringBootTest
@AutoConfigureMockMvc
@ExtendWith(OutputCaptureExtension.class)
class AccountIntegrationTest {
    private static final String PASSWORD = "Register123!";
    private static final String DISPLAY_NAME = "账号回归测试";

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath())) {
            throw new IllegalStateException("TEST_DB_URL must identify the dedicated activity_platform_test REAL MySQL database");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }

    private static String environment(String key, String fallback) {
        String value = System.getenv(key);
        return value == null ? fallback : value;
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired PasswordEncoder encoder;
    @Autowired ObjectMapper json;
    @Autowired ActivityService activities;
    private final Set<String> usernames = new LinkedHashSet<>();
    private final List<Long> activityIds = new ArrayList<>();

    @BeforeEach
    void verifyDedicatedDatabase() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
    }

    @AfterEach
    void deleteOnlyOwnedFixtures() {
        for (long id : activityIds) {
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=? AND description=?", id, "Account integration fixture");
        }
        for (String username : usernames) {
            // Exact names are registered before each write, including a response lost to a failing assertion.
            jdbc.update("DELETE FROM users WHERE username=? AND role='USER'", username);
        }
    }

    @Test
    void registrationCanonicalizesUsernameHashesPasswordAndNeverAcceptsPrivilegesOrSignsIn(CapturedOutput output) throws Exception {
        String username = newUsername();
        long demoId = users.findByUsername("demo").id();
        var csrfResult = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        MockHttpSession session = (MockHttpSession) csrfResult.getRequest().getSession(false);
        var token = json.readTree(csrfResult.getResponse().getContentAsString());
        var response = mvc.perform(post("/api/auth/register").session(session)
                .header(token.get("headerName").asString(), token.get("token").asString())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                    "username", "  " + username.toUpperCase(Locale.ROOT) + "  ", "password", PASSWORD,
                    "displayName", "  " + DISPLAY_NAME + "  ", "role", "ADMIN", "id", demoId, "userId", demoId))))
            .andExpect(status().isCreated()).andExpect(jsonPath("$.username").value(username))
            .andExpect(jsonPath("$.displayName").value(DISPLAY_NAME)).andExpect(jsonPath("$.role").value("USER"))
            .andExpect(jsonPath("$.password").doesNotExist()).andExpect(jsonPath("$.passwordHash").doesNotExist()).andReturn();
        var row = users.findByUsername(username);
        assertThat(row.id()).isNotEqualTo(demoId);
        assertThat(row.passwordHash()).startsWith("$2a$12$").isNotEqualTo(PASSWORD);
        assertThat(encoder.matches(PASSWORD, row.passwordHash())).isTrue();
        assertThat(row.role()).isEqualTo("USER");
        assertThat(UUID.fromString(response.getResponse().getHeader("X-Request-Id"))).isNotNull();
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized());
        assertThat(session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).isNull();
        assertThat(output.getAll()).doesNotContain(PASSWORD, row.passwordHash());
        assertThat(output.getAll()).contains("/api/auth/register");
    }

    @Test
    void registrationRequiresRealCsrfAndDoesNotRotateItOrAuthenticate() throws Exception {
        String username = newUsername();
        String body = registrationBody(username, PASSWORD, DISPLAY_NAME);
        mvc.perform(post("/api/auth/register").contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(users.findByUsername(username)).isNull();
        var initial = mvc.perform(get("/api/auth/csrf")).andReturn();
        MockHttpSession session = (MockHttpSession) initial.getRequest().getSession(false);
        var token = json.readTree(initial.getResponse().getContentAsString());
        mvc.perform(post("/api/auth/register").session(session).header(token.get("headerName").asString(), "wrong-token")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(post("/api/auth/register").session(session)
                .header(token.get("headerName").asString(), token.get("token").asString())
                .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isCreated());
        var after = mvc.perform(get("/api/auth/csrf").session(session)).andReturn();
        assertThat(json.readTree(after.getResponse().getContentAsString()).get("token").asString())
            .isEqualTo(token.get("token").asString());
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isUnauthorized());
    }

    @Test
    void usernamesEnforceAsciiAndNormalizedLengthWhileLoginRetainsExistingLongAccounts() throws Exception {
        for (String invalid : List.of("", "ab", "a".repeat(33), "1abc", "a-b", "中文账号", "Kabc", "a b")) {
            invalidRegistration(invalid, PASSWORD, DISPLAY_NAME);
        }
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("password", PASSWORD, "displayName", DISPLAY_NAME))))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        String username = newUsername();
        register(username, PASSWORD, DISPLAY_NAME);
        assertThat(username).hasSize(32);
        login(" " + username.toUpperCase(Locale.ROOT) + " ", PASSWORD);
        String legacy = "account_legacy_" + UUID.randomUUID().toString().replace("-", "");
        assertThat(users.findByUsername(legacy)).isNull();
        usernames.add(legacy);
        users.insert(legacy, users.findByUsername("demo").passwordHash(), DISPLAY_NAME, "USER");
        login(legacy.toUpperCase(Locale.ROOT), "Demo123!");
    }

    @Test
    void passwordsEnforceCharacterAndUtf8LimitsAndNeverTrim() throws Exception {
        for (String invalid : List.of("Ab12345", "a1" + "x".repeat(63), "abcdefgh", "12345678", "中文中文1234",
            "a1" + "汉".repeat(23) + "bc")) invalidRegistration(newUsername(), invalid, DISPLAY_NAME);
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("username", newUsername(), "displayName", DISPLAY_NAME))))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        for (String valid : List.of("Ab123456", "a1" + "x".repeat(62), "a1" + "汉".repeat(23) + "b", " Ab12345 ")) {
            String username = newUsername();
            register(username, valid, DISPLAY_NAME);
            assertThat(encoder.matches(valid, users.findByUsername(username).passwordHash())).isTrue();
        }
        String username = newUsername();
        register(username, " Ab12345 ", DISPLAY_NAME);
        mvc.perform(post("/api/auth/login").with(csrf()).param("username", username).param("password", "Ab12345"))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
        login(username, " Ab12345 ");
    }

    @Test
    void displayNamesUseUtf16LimitsTrimSpacesAndRejectC0AndC1Controls() throws Exception {
        for (String invalid : List.of("", "   ", "名".repeat(41), "😀".repeat(21), "x\u0000y", "\n昵称\n", "x\u007fy", "x\u0085y", "x\ty")) {
            invalidRegistration(newUsername(), PASSWORD, invalid);
        }
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("username", newUsername(), "password", PASSWORD))))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        for (String valid : List.of("名", "名".repeat(40), "😀".repeat(20))) {
            String username = newUsername();
            register(username, PASSWORD, "  " + valid + "  ");
            assertThat(users.findByUsername(username).displayName()).isEqualTo(valid);
        }
    }

    @Test
    void malformedOrMissingRegistrationAndProfileBodiesReturnStaticJsonErrors() throws Exception {
        for (String body : List.of("{}", "null", "[]", "{broken:payload}")) {
            mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        var principal = new AppUserDetails(users.findByUsername("demo"));
        for (String body : List.of("{}", "null", "[]", "{broken:payload}")) {
            mvc.perform(patch("/api/me/profile").with(user(principal)).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
    }

    @Test
    void concurrentNormalizedUsernameCollisionsHaveExactlyOneWinnerAndSafe409Errors(CapturedOutput output) throws Exception {
        String username = newUsername();
        var start = new CountDownLatch(1);
        var ready = new CountDownLatch(4);
        List<Future<MvcResult>> results = new ArrayList<>();
        try (var workers = Executors.newFixedThreadPool(4)) {
            for (int index = 0; index < 4; index++) {
                String submitted = index % 2 == 0 ? " " + username.toUpperCase(Locale.ROOT) + " " : username;
                results.add(workers.submit(() -> {
                    ready.countDown();
                    if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Registration start barrier timed out");
                    return mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                        .content(registrationBody(submitted, PASSWORD, DISPLAY_NAME))).andReturn();
                }));
            }
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (var future : results) {
                var result = future.get(30, TimeUnit.SECONDS);
                statuses.add(result.getResponse().getStatus());
                if (result.getResponse().getStatus() == 409) {
                    var error = json.readTree(result.getResponse().getContentAsString());
                    assertThat(error.get("code").asString()).isEqualTo("USERNAME_TAKEN");
                    assertThat(error.get("message").asString()).isEqualTo("用户名已被使用");
                }
            }
            assertThat(statuses).containsExactlyInAnyOrder(201, 409, 409, 409);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE username=?", Integer.class, username)).isEqualTo(1);
        assertThat(encoder.matches(PASSWORD, users.findByUsername(username).passwordHash())).isTrue();
        assertThat(output.getAll()).doesNotContain(PASSWORD, users.findByUsername(username).passwordHash(), "Duplicate entry");
        invalidDuplicate(username);
    }

    @Test
    void profileRequiresAuthenticationAndCsrfAndRejectsInvalidNamesWithoutChangingData() throws Exception {
        String username = newUsername();
        register(username, PASSWORD, DISPLAY_NAME);
        var principal = new AppUserDetails(users.findByUsername(username));
        String body = json.writeValueAsString(Map.of("displayName", "新昵称"));
        mvc.perform(patch("/api/me/profile").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(patch("/api/me/profile").with(user(principal)).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        for (String invalid : List.of("", " ", "x".repeat(41), "昵称\n", "x\u009fy")) {
            mvc.perform(patch("/api/me/profile").with(user(principal)).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(Map.of("displayName", invalid))))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        assertThat(users.findByUsername(username).displayName()).isEqualTo(DISPLAY_NAME);
    }

    @Test
    void profileUsesTrustedPrincipalIdAndCannotChangeOtherAccountsOrPrivilegeFields() throws Exception {
        String username = newUsername();
        String otherUsername = newUsername();
        register(username, PASSWORD, DISPLAY_NAME);
        register(otherUsername, PASSWORD, DISPLAY_NAME);
        var row = users.findByUsername(username);
        var other = users.findByUsername(otherUsername);
        mvc.perform(patch("/api/me/profile").with(user(new AppUserDetails(row))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                    "displayName", "  更新昵称  ", "id", other.id(), "userId", other.id(), "role", "ADMIN",
                    "username", otherUsername, "password", "OtherPassword123!"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(row.id()))
            .andExpect(jsonPath("$.username").value(username)).andExpect(jsonPath("$.role").value("USER"))
            .andExpect(jsonPath("$.displayName").value("更新昵称")).andExpect(jsonPath("$.passwordHash").doesNotExist());
        assertThat(users.findByUsername(username).passwordHash()).isEqualTo(row.passwordHash());
        assertThat(users.findByUsername(username).role()).isEqualTo("USER");
        assertThat(users.findByUsername(otherUsername)).isEqualTo(other);
        mvc.perform(get("/api/auth/me").with(user(new AppUserDetails(row))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("更新昵称"));
    }

    @Test
    void independentSessionsReadLatestProfileWithoutReplacingContextOrCsrfAndLogoutStaysLocal() throws Exception {
        String username = newUsername();
        register(username, PASSWORD, DISPLAY_NAME);
        MockHttpSession first = login(username, PASSWORD);
        MockHttpSession second = login(username, PASSWORD);
        Object firstContext = first.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        Object secondContext = second.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        var csrfBefore = mvc.perform(get("/api/auth/csrf").session(first)).andReturn();
        var csrf = json.readTree(csrfBefore.getResponse().getContentAsString());
        mvc.perform(patch("/api/me/profile").session(first).header(csrf.get("headerName").asString(), csrf.get("token").asString())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("displayName", "新昵称😀"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("新昵称😀"));
        for (MockHttpSession session : List.of(first, second)) {
            mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("新昵称😀"));
        }
        assertThat(first.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).isSameAs(firstContext);
        assertThat(second.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).isSameAs(secondContext);
        assertThat(((AppUserDetails) ((SecurityContext) secondContext).getAuthentication().getPrincipal()).view().displayName())
            .isEqualTo(DISPLAY_NAME);
        var unchanged = mvc.perform(get("/api/auth/csrf").session(first)).andReturn();
        assertThat(json.readTree(unchanged.getResponse().getContentAsString()).get("token").asString()).isEqualTo(csrf.get("token").asString());
        mvc.perform(post("/api/auth/logout").session(first).header(csrf.get("headerName").asString(), csrf.get("token").asString()))
            .andExpect(status().isOk());
        assertThat(first.isInvalid()).isTrue();
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(get("/api/auth/me").session(second)).andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("新昵称😀"));
        var afterLogout = mvc.perform(get("/api/auth/csrf")).andReturn();
        assertThat(json.readTree(afterLogout.getResponse().getContentAsString()).get("token").asString()).isNotEqualTo(csrf.get("token").asString());
        MockHttpSession relogin = login(username, PASSWORD);
        mvc.perform(get("/api/auth/me").session(relogin)).andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("新昵称😀"));
        assertThat(((AppUserDetails) ((SecurityContext) relogin.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY))
            .getAuthentication().getPrincipal()).view().displayName()).isEqualTo("新昵称😀");
    }

    @Test
    void newUsersCanRegisterForActivitiesAndSeeTheirRecordButCannotCallAdminApis() throws Exception {
        String username = newUsername();
        register(username, PASSWORD, DISPLAY_NAME);
        MockHttpSession session = login(username, PASSWORD);
        long activityId = activities.create(new CreateActivityRequest("Account " + UUID.randomUUID(), "Account integration fixture",
            "Test venue", Instant.now().plusSeconds(7200), 1), users.findByUsername("admin").id()).id();
        activityIds.add(activityId);
        mvc.perform(post("/api/activities/" + activityId + "/registration").session(session).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.registrationStatus").value("ACTIVE"))
            .andExpect(jsonPath("$.registeredCount").value(1));
        mvc.perform(get("/api/me/registrations").session(session)).andExpect(status().isOk())
            .andExpect(jsonPath("$[0].activity.id").value(activityId)).andExpect(jsonPath("$[0].status").value("ACTIVE"));
        mvc.perform(get("/api/admin/overview").session(session)).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(post("/api/admin/activities").session(session).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(delete("/api/activities/" + activityId + "/registration").session(session).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.registeredCount").value(0));
    }

    private String newUsername() {
        String username = "u" + UUID.randomUUID().toString().replace("-", "").substring(0, 31);
        assertThat(users.findByUsername(username)).isNull();
        usernames.add(username);
        return username;
    }

    private String registrationBody(String username, String password, String displayName) throws Exception {
        return json.writeValueAsString(Map.of("username", username, "password", password, "displayName", displayName));
    }

    private void register(String username, String password, String displayName) throws Exception {
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(registrationBody(username, password, displayName)))
            .andExpect(status().isCreated());
    }

    private void invalidRegistration(String username, String password, String displayName) throws Exception {
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(registrationBody(username, password, displayName)))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    private void invalidDuplicate(String username) throws Exception {
        mvc.perform(post("/api/auth/register").with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content(registrationBody(" " + username.toUpperCase(Locale.ROOT) + " ", PASSWORD, DISPLAY_NAME)))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("USERNAME_TAKEN"));
    }

    private MockHttpSession login(String username, String password) throws Exception {
        var result = mvc.perform(post("/api/auth/login").with(csrf()).contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .param("username", username).param("password", password))
            .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }
}

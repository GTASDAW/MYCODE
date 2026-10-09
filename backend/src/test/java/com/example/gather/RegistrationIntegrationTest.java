package com.example.gather;

import com.example.gather.api.ApiModels.CreateActivityRequest;
import com.example.gather.config.DemoDataInitializer;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.RegistrationService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.session.SessionRepository;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL only. TEST_DB_URL must point at a dedicated integration-test database. */
@SpringBootTest
@AutoConfigureMockMvc
class RegistrationIntegrationTest {
    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")) {
            throw new IllegalStateException("Set TEST_DB_URL to a dedicated REAL MySQL database before running integration tests.");
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
    @Autowired ObjectMapper json;
    @Autowired ActivityService activities;
    @Autowired ActivityMapper activityMapper;
    @Autowired PlatformTransactionManager transactions;
    @Autowired RegistrationService registrations;
    @Autowired UserMapper users;
    @Autowired DemoDataInitializer demoData;
    @Autowired ApplicationContext application;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanCreatedTestRecords() {
        for (long id : activityIds) {
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
        for (long id : userIds) jdbc.update("DELETE FROM users WHERE id=?", id);
    }

    @Test
    void publicActivitiesComeFromDatabaseAndExposeUtcTime() throws Exception {
        long id = createActivity(4);
        mvc.perform(get("/api/activities/" + id))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id))
            .andExpect(jsonPath("$.capacity").value(4)).andExpect(jsonPath("$.registrationStatus").isEmpty())
            .andExpect(jsonPath("$.startsAt").value(org.hamcrest.Matchers.endsWith("Z")));
        mvc.perform(get("/api/activities")).andExpect(status().isOk()).andExpect(jsonPath("$[0].id").exists());
        mvc.perform(get("/api/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UP"));
        assertThat(application.getBeansOfType(SessionRepository.class)).isEmpty();
        assertThat(application.getBeansOfType(SessionRepositoryFilter.class)).isEmpty();
        mvc.perform(get("/api/activities/9223372036854775807"))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("ACTIVITY_NOT_FOUND"));
    }

    @Test
    void loginRotatesCsrfAndLogoutInvalidatesSession() throws Exception {
        var tokenResult = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        MockHttpSession session = (MockHttpSession) tokenResult.getRequest().getSession(false);
        var token = json.readTree(tokenResult.getResponse().getContentAsString());
        String headerName = token.get("headerName").asString();
        String beforeLogin = token.get("token").asString();
        mvc.perform(post("/api/auth/login").session(session).header(headerName, beforeLogin)
            .contentType(MediaType.APPLICATION_FORM_URLENCODED).param("username", "demo").param("password", "Demo123!"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.username").value("demo"))
            .andExpect(jsonPath("$.role").value("USER")).andExpect(jsonPath("$.passwordHash").doesNotExist());
        mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.username").value("demo"));
        var authentication = ((SecurityContext) session.getAttribute(
            HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).getAuthentication();
        assertThat(authentication.getCredentials()).isNull();
        assertThat(((AppUserDetails) authentication.getPrincipal()).getPassword()).isNull();
        var next = mvc.perform(get("/api/auth/csrf").session(session)).andReturn();
        String afterLogin = json.readTree(next.getResponse().getContentAsString()).get("token").asString();
        assertThat(afterLogin).isNotEqualTo(beforeLogin);
        mvc.perform(post("/api/auth/logout").session(session).header(headerName, beforeLogin))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(post("/api/auth/logout").session(session).header(headerName, afterLogin))
            .andExpect(status().isOk()).andExpect(jsonPath("$.success").value(true));
        assertThat(session.isInvalid()).isTrue();
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized());
    }

    @Test
    void rejectsBadLoginMissingCsrfAndUnauthorizedAdminWrites() throws Exception {
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(post("/api/auth/login").param("username", "demo").param("password", "Demo123!"))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(post("/api/auth/login").with(csrf()).param("username", "demo").param("password", "wrong"))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("INVALID_CREDENTIALS"));
        mvc.perform(post("/api/admin/activities").with(csrf()).with(user(new AppUserDetails(users.findByUsername("demo"))))
            .contentType(MediaType.APPLICATION_JSON).content(activityBody(5)))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mvc.perform(post("/api/activities/1/registration").with(csrf()))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void adminCanCreateAndInvalidCreationReturns400() throws Exception {
        var result = mvc.perform(post("/api/admin/activities").with(csrf()).with(user(new AppUserDetails(users.findByUsername("admin"))))
            .contentType(MediaType.APPLICATION_JSON).content(activityBody(5)))
            .andExpect(status().isCreated()).andExpect(header().exists("Location"))
            .andExpect(jsonPath("$.capacity").value(5)).andExpect(jsonPath("$.registeredCount").value(0)).andReturn();
        activityIds.add(json.readTree(result.getResponse().getContentAsString()).get("id").asLong());
        mvc.perform(post("/api/admin/activities").with(csrf()).with(user(new AppUserDetails(users.findByUsername("admin"))))
            .contentType(MediaType.APPLICATION_JSON).content(activityBody(0)))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        mvc.perform(post("/api/admin/activities").with(csrf()).with(user(new AppUserDetails(users.findByUsername("admin"))))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"x\",\"startsAt\":\"invalid\"}"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    @Test
    void repeatedRegisterCancelAndRejoinKeepOneRowAndExactCounter() throws Exception {
        long id = createActivity(1);
        var principal = new AppUserDetails(users.findByUsername("demo"));
        for (int i = 0; i < 2; i++) {
            mvc.perform(post("/api/activities/" + id + "/registration").with(csrf()).with(user(principal)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.registeredCount").value(1))
                .andExpect(jsonPath("$.registrationStatus").value("ACTIVE"));
        }
        for (int i = 0; i < 2; i++) {
            mvc.perform(delete("/api/activities/" + id + "/registration").with(csrf()).with(user(principal)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.registeredCount").value(0))
                .andExpect(jsonPath("$.registrationStatus").value("CANCELLED"));
        }
        mvc.perform(get("/api/me/registrations").with(user(principal)))
            .andExpect(status().isOk()).andExpect(jsonPath("$[?(@.activity.id == " + id + ")].status").value(org.hamcrest.Matchers.hasItem("CANCELLED")));
        registrations.register(id, principal.id());
        assertThat(activities.get(id, principal.id()).registeredCount()).isEqualTo(1);
        assertThat(countRows(id)).isEqualTo(1);
    }

    @Test
    void fullActivityQueuesWaitingAndCancellationPromotesOne() {
        long id = createActivity(1);
        long first = users.findByUsername("demo").id();
        long second = createUser();
        registrations.register(id, first);
        assertThat(registrations.register(id, second).registrationStatus()).isEqualTo("WAITING");
        assertThat(registrations.register(id, second).registrationStatus()).isEqualTo("WAITING");
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isEqualTo(1);
        assertThat(countRows(id)).isEqualTo(2);
        registrations.cancel(id, first);
        assertThat(activities.get(id, second).registrationStatus()).isEqualTo("ACTIVE");
        assertThat(activities.get(id, second).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isZero();
    }

    @Test
    void lockProjectionMapsRequiredFieldsAndPreservesLiveCandidateDetails() {
        long id = createActivity(1);
        var before = activities.get(id, null);
        var locked = new TransactionTemplate(transactions).execute(status -> activityMapper.lockById(id));
        assertThat(locked).isNotNull();
        assertThat(locked.startsAt().toInstant(ZoneOffset.UTC)).isEqualTo(before.startsAt());
        assertThat(locked.capacity()).isEqualTo(1);
        assertThat(locked.registeredCount()).isZero();

        long active = users.findByUsername("demo").id();
        long firstWaiting = createUser();
        long secondWaiting = createUser();
        registrations.register(id, active);
        registrations.register(id, firstWaiting);
        var joined = registrations.register(id, secondWaiting);
        assertThat(joined.registrationStatus()).isEqualTo("WAITING");
        assertThat(joined.waitingCount()).isEqualTo(2);
        assertThat(activities.get(id, null).waitingCount()).isEqualTo(2);

        var cancelled = registrations.cancel(id, active);
        assertThat(cancelled.registeredCount()).isEqualTo(1);
        assertThat(cancelled.waitingCount()).isEqualTo(1);
        assertThat(activities.get(id, firstWaiting).registrationStatus()).isEqualTo("ACTIVE");
        assertThat(activities.get(id, secondWaiting).registrationStatus()).isEqualTo("WAITING");
    }

    @Test
    void waitingQueuePromotesOldestUpdatedAtThenId() {
        long id = createActivity(1);
        long first = users.findByUsername("demo").id();
        long second = createUser();
        long third = createUser();
        registrations.register(id, first);
        registrations.register(id, second);
        registrations.register(id, third);
        LocalDateTime base = LocalDateTime.now(ZoneOffset.UTC).minusMinutes(5);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id=?", base.plusSeconds(20), id, second);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id=?", base.plusSeconds(30), id, third);
        registrations.cancel(id, first);
        assertThat(activities.get(id, second).registrationStatus()).isEqualTo("ACTIVE");
        assertThat(activities.get(id, third).registrationStatus()).isEqualTo("WAITING");
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isEqualTo(1);
    }

    @Test
    void cancellingWaitingDoesNotPromoteOrChangeCounter() {
        long id = createActivity(1);
        long first = users.findByUsername("demo").id();
        long second = createUser();
        registrations.register(id, first);
        registrations.register(id, second);
        assertThat(registrations.cancel(id, second).registrationStatus()).isEqualTo("CANCELLED");
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isZero();
        assertThat(activities.get(id, first).registrationStatus()).isEqualTo("ACTIVE");
    }

    @Test
    void cancelledUserRejoinsQueueWhenActivityIsFull() {
        long id = createActivity(1);
        long first = users.findByUsername("demo").id();
        long second = createUser();
        registrations.register(id, first);
        registrations.register(id, second);
        registrations.cancel(id, second);
        assertThat(registrations.register(id, second).registrationStatus()).isEqualTo("WAITING");
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isEqualTo(1);
        assertThat(countRows(id)).isEqualTo(2);
    }

    @Test
    void startedActivityForbidsBothRegistrationAndCancellation() throws Exception {
        long id = createActivity(2);
        var principal = new AppUserDetails(users.findByUsername("demo"));
        registrations.register(id, principal.id());
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", LocalDateTime.ofInstant(Instant.now().minusSeconds(10), ZoneOffset.UTC), id);
        mvc.perform(post("/api/activities/" + id + "/registration").with(csrf()).with(user(principal)))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CLOSED"));
        mvc.perform(delete("/api/activities/" + id + "/registration").with(csrf()).with(user(principal)))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CLOSED"));
        assertThat(activities.get(id, principal.id()).closed()).isTrue();
        assertThat(activities.get(id, principal.id()).registeredCount()).isEqualTo(1);
    }

    @Test
    void failedInsertRollsBackEarlierCounterChange() {
        long id = createActivity(3);
        // Counter UPDATE occurs first. A foreign-key failure in INSERT must roll back that UPDATE.
        assertThatThrownBy(() -> registrations.register(id, Long.MAX_VALUE)).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(activities.get(id, null).registeredCount()).isZero();
        assertThat(countRows(id)).isZero();
    }

    @Test
    void oneHundredConcurrentUsersCompeteForTenSeatsOnRealMysql() throws Exception {
        long id = createActivity(10);
        List<Long> participants = new ArrayList<>();
        for (int i = 0; i < 100; i++) participants.add(createUser());
        CountDownLatch start = new CountDownLatch(1);
        List<Future<String>> attempts = new ArrayList<>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (long userId : participants) {
                attempts.add(executor.submit(() -> {
                    start.await();
                    return registrations.register(id, userId).registrationStatus();
                }));
            }
            start.countDown();
            int active = 0;
            int waiting = 0;
            for (Future<String> attempt : attempts) {
                if (attempt.get(60, TimeUnit.SECONDS).equals("ACTIVE")) active++;
                else waiting++;
            }
            assertThat(active).isEqualTo(10);
            assertThat(waiting).isEqualTo(90);
        }
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(10);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status='ACTIVE'", Integer.class, id)).isEqualTo(10);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status='WAITING'", Integer.class, id)).isEqualTo(90);
        assertThat(countRows(id)).isEqualTo(100);
        System.out.println("MYSQL CONCURRENCY VERIFIED: 100 distinct users / 10 capacity / 10 active / 90 waiting / exact counter.");
    }

    @Test
    void fiftyIndependentActivitiesCanRegisterConcurrentlyWithoutGapLockDeadlocks() throws Exception {
        List<Long> independentActivities = new ArrayList<>();
        List<Long> participants = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            independentActivities.add(createActivity(1));
            participants.add(createUser());
        }
        // These newly created activity keys have no registrations. All first inserts must succeed,
        // even when the registration index is empty or their missing keys share one sparse range.
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> attempts = new ArrayList<>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < independentActivities.size(); i++) {
                long activityId = independentActivities.get(i);
                long userId = participants.get(i);
                attempts.add(executor.submit(() -> {
                    start.await();
                    registrations.register(activityId, userId);
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> attempt : attempts) attempt.get(60, TimeUnit.SECONDS);
        }
        for (long activityId : independentActivities) {
            assertThat(activities.get(activityId, null).registeredCount()).isEqualTo(1);
            assertThat(countRows(activityId)).isEqualTo(1);
        }
        System.out.println("MYSQL CROSS-ACTIVITY VERIFIED: 50 activities / 50 users / 50 successes / no deadlocks.");
    }

    @Test
    void concurrentRestartingSeedDoesNotResetPasswordsTimesOrCountersAndReleasesLock() throws Exception {
        var demo = users.findByUsername("demo");
        long id = createActivity(2);
        registrations.register(id, demo.id());
        var before = activities.get(id, demo.id());
        var allBefore = activities.list(demo.id());
        try (var executor = Executors.newFixedThreadPool(8)) {
            var start = new CountDownLatch(1);
            var attempts = new ArrayList<Future<?>>();
            for (int attempt = 0; attempt < 8; attempt++) {
                attempts.add(executor.submit(() -> {
                    start.await();
                    demoData.run(null);
                    return null;
                }));
            }
            start.countDown();
            for (var attempt : attempts) attempt.get(60, TimeUnit.SECONDS);
        }
        assertThat(users.findByUsername("demo").passwordHash()).isEqualTo(demo.passwordHash());
        assertThat(activities.get(id, demo.id())).isEqualTo(before);
        assertThat(activities.list(demo.id())).isEqualTo(allBefore);
        assertThat(jdbc.queryForObject("SELECT IS_FREE_LOCK(CONCAT('gather:demo-seed:', MD5(DATABASE())))", Integer.class))
            .isEqualTo(1);
    }

    private long createActivity(int capacity) {
        var created = activities.create(new CreateActivityRequest("Integration " + UUID.randomUUID(), "Test description", "Test venue",
            Instant.now().plusSeconds(86400), capacity), users.findByUsername("admin").id());
        activityIds.add(created.id());
        return created.id();
    }

    private String activityBody(int capacity) {
        return json.writeValueAsString(new CreateActivityRequest("Integration " + UUID.randomUUID(), "Test description", "Test venue",
            Instant.now().plusSeconds(86400), capacity));
    }

    private long createUser() {
        String username = "test_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Concurrent test user", "USER");
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private int countRows(long activityId) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=?", Integer.class, activityId);
    }
}

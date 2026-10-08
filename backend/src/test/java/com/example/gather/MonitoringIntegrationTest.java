package com.example.gather;

import com.example.gather.api.ApiModels.CreateActivityRequest;
import com.example.gather.mapper.UserMapper;
import com.example.gather.monitoring.MonitoringService;
import com.example.gather.monitoring.RequestObservationFilter;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.RegistrationService;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.annotation.OrderUtils;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.ObjectMapper;
import javax.sql.DataSource;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@Import(MonitoringIntegrationTest.ProbeConfiguration.class)
@ExtendWith(OutputCaptureExtension.class)
class MonitoringIntegrationTest {
    private static final String PRIVATE_MARKER = "DO_NOT_LOG_TEST_SENTINEL";

    @TestConfiguration(proxyBeanMethods = false)
    static class ProbeConfiguration {
        @Bean
        ProbeController probeController() { return new ProbeController(); }
    }

    @RestController
    static class ProbeController {
        @GetMapping("/api/__monitoring_failure")
        Map<String, Object> failure() {
            throw new IllegalStateException(PRIVATE_MARKER,
                new SQLException("jdbc:mysql://private-host/test?password=" + PRIVATE_MARKER));
        }

        @GetMapping("/api/__monitoring_conflict")
        Map<String, Object> conflict() { throw new DataIntegrityViolationException(PRIVATE_MARKER); }

        @GetMapping("/api/__monitoring_context")
        Map<String, Object> context(HttpServletRequest request) {
            return Map.of("mdc", MDC.get("requestId"), "attribute", request.getAttribute(RequestObservationFilter.REQUEST_ID_ATTRIBUTE));
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !url.contains("activity_platform_test")) {
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
    @Autowired ObjectMapper json;
    @Autowired MonitoringService monitoring;
    @Autowired MeterRegistry registry;
    @Autowired UserMapper users;
    @Autowired JdbcTemplate jdbc;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired DataSource dataSource;
    private final List<Long> activityIds = new ArrayList<>();

    @AfterEach
    void cleanup() {
        MDC.remove("requestId");
        for (long id : activityIds) {
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
    }

    @Test
    void generatedRequestIdCoversSuccessSecurityValidationMissingAndServerErrors() throws Exception {
        List<MvcResult> responses = List.of(
            mvc.perform(get("/api/activities")).andExpect(status().isOk()).andReturn(),
            mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHENTICATED")).andReturn(),
            mvc.perform(get("/api/admin/monitoring").with(user(principal("demo")))).andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN")).andReturn(),
            mvc.perform(post("/api/auth/login")).andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_INVALID")).andReturn(),
            mvc.perform(get("/api/admin/activities").with(user(principal("admin"))).param("page", "0"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR")).andReturn(),
            mvc.perform(get("/api/activities/9223372036854775807")).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("ACTIVITY_NOT_FOUND")).andReturn(),
            mvc.perform(get("/api/__monitoring_failure").with(user(principal("demo"))))
                .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.message").value("服务暂时不可用，请稍后重试"))
                .andExpect(jsonPath("$.requestId").doesNotExist()).andReturn());
        List<String> ids = responses.stream().map(this::requestId).toList();
        assertThat(ids).doesNotHaveDuplicates();
        for (MvcResult response : responses) {
            assertThat(response.getRequest().getAttribute(RequestObservationFilter.REQUEST_ID_ATTRIBUTE)).isEqualTo(requestId(response));
        }
        assertThat(MDC.get("requestId")).isNull();
        assertThat(OrderUtils.getOrder(RequestObservationFilter.class)).isLessThan(SessionRepositoryFilter.DEFAULT_ORDER);
    }

    @Test
    void incomingHeaderIsIgnoredAndMdcIsRestoredForThreadReuse() throws Exception {
        String foreign = PRIVATE_MARKER + "\r\nforged";
        var result = mvc.perform(get("/api/__monitoring_context").header("X-Request-Id", foreign)
            .with(user(principal("demo")))).andExpect(status().isOk()).andReturn();
        String id = requestId(result);
        assertThat(id).isNotEqualTo(foreign);
        assertThat(json.readTree(result.getResponse().getContentAsString()).get("mdc").asString()).isEqualTo(id);
        assertThat(MDC.get("requestId")).isNull();
        MDC.put("requestId", "outer-context");
        var denied = mvc.perform(get("/api/auth/me").header("X-Request-Id", foreign)).andExpect(status().isUnauthorized()).andReturn();
        assertThat(requestId(denied)).isNotEqualTo("outer-context");
        assertThat(MDC.get("requestId")).isEqualTo("outer-context");
    }

    @Test
    void structuredLogsKeepRouteTemplatesAndExcludeAllUntrustedPayloadsAndExceptionMessages(CapturedOutput output) throws Exception {
        var unknown = mvc.perform(get("/api/private-" + PRIVATE_MARKER).with(user(principal("demo")))
            .queryParam("token", PRIVATE_MARKER)).andExpect(status().isNotFound()).andReturn();
        var malformed = mvc.perform(post("/api/admin/activities").with(csrf()).with(user(principal("admin")))
            .header("X-Request-Id", PRIVATE_MARKER).contentType(MediaType.APPLICATION_JSON)
            .content("{malformed:" + PRIVATE_MARKER + "}")).andExpect(status().isBadRequest()).andReturn();
        var failure = mvc.perform(get("/api/__monitoring_failure").with(user(principal("demo"))))
            .andExpect(status().isInternalServerError()).andReturn();
        var conflict = mvc.perform(get("/api/__monitoring_conflict").with(user(principal("demo"))))
            .andExpect(status().isConflict()).andReturn();
        var missing = mvc.perform(get("/api/activities/9223372036854775807").queryParam("password", PRIVATE_MARKER))
            .andExpect(status().isNotFound()).andReturn();
        assertThat(output.getAll()).doesNotContain(PRIVATE_MARKER, "private-host");
        for (MvcResult result : List.of(unknown, malformed, failure, conflict, missing)) {
            String id = requestId(result);
            var line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(id)
                && value.contains("http_request")).findFirst().orElseThrow();
            var event = json.readTree(line);
            assertThat(line).doesNotContain("jdbc:mysql://", "stack_trace");
            assertThat(event.get("event").asString()).isEqualTo("http_request");
            assertThat(event.get("status").asInt()).isEqualTo(result.getResponse().getStatus());
            assertThat(event.get("durationMs").asDouble()).isGreaterThanOrEqualTo(0);
            assertThat(event.get("requestId").asString()).isEqualTo(id);
            assertThat(event.get("route").asString()).isEqualTo(result == missing ? "/api/activities/{id}"
                : result == malformed ? "/api/admin/activities" : "/UNKNOWN");
        }
    }

    @Test
    void monitoringIsAdminOnlyAndDoesNotExposeActuatorMetricsOrUserData() throws Exception {
        mvc.perform(get("/api/admin/monitoring")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/admin/monitoring").with(user(principal("demo")))).andExpect(status().isForbidden());
        var response = mvc.perform(get("/api/admin/monitoring").with(user(principal("admin"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.scope").value("CURRENT_JVM"))
            .andExpect(jsonPath("$.instanceId").value("local")).andExpect(jsonPath("$.latencyWindowSeconds").value(300))
            .andExpect(jsonPath("$.databasePool.max").value(20)).andExpect(jsonPath("$.databasePool.active").isNumber())
            .andExpect(jsonPath("$.startedAt").value(org.hamcrest.Matchers.endsWith("Z")))
            .andExpect(jsonPath("$.sampledAt").value(org.hamcrest.Matchers.endsWith("Z"))).andReturn();
        assertThat(response.getResponse().getContentAsString()).doesNotContain("password", "username", "cookie", "token", "userId");
        mvc.perform(get("/api/metrics")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/metrics").with(user(principal("admin")))).andExpect(status().isNotFound());
        mvc.perform(get("/api/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void measurementsCountRealRequestsAndExcludeHealthAndMonitoringReads() throws Exception {
        long before = monitoring.snapshot().totalRequests();
        long clientBefore = monitoring.snapshot().clientErrors();
        long serverBefore = monitoring.snapshot().serverErrors();
        mvc.perform(get("/api/activities")).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/__monitoring_failure").with(user(principal("demo")))).andExpect(status().isInternalServerError());
        for (int i = 0; i < 2; i++) {
            mvc.perform(get("/api/health")).andExpect(status().isOk());
            mvc.perform(get("/api/admin/monitoring").with(user(principal("admin")))).andExpect(status().isOk());
        }
        var view = monitoring.snapshot();
        assertThat(view.totalRequests()).isEqualTo(before + 3);
        assertThat(view.clientErrors()).isEqualTo(clientBefore + 1);
        assertThat(view.serverErrors()).isEqualTo(serverBefore + 1);
        assertThat(view.averageDurationMs()).isPositive();
        assertThat(view.routes()).allSatisfy(route -> {
            assertThat(route.route()).doesNotContain("health", "monitoring");
            assertThat(route.count()).isPositive();
            assertThat(route.averageDurationMs()).isPositive();
            assertThat(route.p95DurationMs()).isPositive();
        });
        assertThat(registry.find(MonitoringService.HTTP_TIMER).timers()).allSatisfy(timer ->
            assertThat(timer.getId().getTags()).noneMatch(tag -> tag.getKey().equals("requestId")));
    }

    @Test
    void actualMysqlLockSelectionIsMeasuredWithoutChangingRegistrationOrCandidateSemantics() throws Exception {
        long id = activities.create(new CreateActivityRequest("Monitoring fixture " + UUID.randomUUID(), "Fixture",
            "Fixture", Instant.now().plusSeconds(3600), 1), users.findByUsername("admin").id()).id();
        activityIds.add(id);
        long before = monitoring.snapshot().registrationLock().count();
        var started = new CountDownLatch(1);
        try (var connection = dataSource.getConnection(); var executor = Executors.newSingleThreadExecutor()) {
            connection.setAutoCommit(false);
            try (var statement = connection.prepareStatement("SELECT id FROM activities WHERE id=? FOR UPDATE")) {
                statement.setLong(1, id);
                try (var row = statement.executeQuery()) { assertThat(row.next()).isTrue(); }
            }
            var pending = executor.submit(() -> {
                started.countDown();
                return registrations.register(id, users.findByUsername("demo").id());
            });
            try {
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> pending.get(200, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            } finally {
                connection.rollback();
            }
            assertThat(pending.get(10, TimeUnit.SECONDS).registrationStatus()).isEqualTo("ACTIVE");
        }
        var lock = monitoring.snapshot().registrationLock();
        assertThat(lock.count()).isEqualTo(before + 1);
        assertThat(lock.maxDurationMs()).isGreaterThan(100);
        registrations.cancel(id, users.findByUsername("demo").id());
        assertThat(monitoring.snapshot().registrationLock().count()).isEqualTo(before + 2);
        assertThat(jdbc.queryForObject("SELECT registered_count FROM activities WHERE id=?", Integer.class, id)).isZero();
    }

    private AppUserDetails principal(String username) { return new AppUserDetails(users.findByUsername(username)); }

    private String requestId(MvcResult result) {
        String id = result.getResponse().getHeader(RequestObservationFilter.HEADER);
        assertThat(id).isNotNull();
        assertThat(UUID.fromString(id).toString()).isEqualTo(id);
        return id;
    }
}

package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.monitoring.MonitoringService;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.RegistrationService;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@Import(ActivitySearchIntegrationTest.QueryTestConfiguration.class)
@ExtendWith(OutputCaptureExtension.class)
class ActivitySearchIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-01-10T09:00:00.123456789Z");

    @TestConfiguration(proxyBeanMethods = false)
    static class QueryTestConfiguration {
        @Bean @Primary CountingClock searchClock() { return new CountingClock(); }
        @Bean SearchReadInterceptor searchReadInterceptor() { return new SearchReadInterceptor(); }
    }

    static class CountingClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return NOW; }
    }

    @Intercepts(@Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))
    static class SearchReadInterceptor implements Interceptor {
        final AtomicReference<Runnable> afterTotals = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            Object value = invocation.proceed();
            if (((MappedStatement) invocation.getArgs()[0]).getId().equals(ActivityMapper.class.getName() + ".searchTotals")) {
                Runnable action = afterTotals.getAndSet(null);
                if (action != null) action.run();
            }
            return value;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !java.net.URI.create(url.substring("jdbc:".length())).getPath().equals("/activity_platform_test")) {
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
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired AdminService admin;
    @Autowired MonitoringService monitoring;
    @Autowired CountingClock clock;
    @Autowired SearchReadInterceptor reads;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanOnlyCreatedFixtures() {
        reads.afterTotals.set(null);
        for (long id : activityIds) {
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
        for (long id : userIds) jdbc.update("DELETE FROM users WHERE id=?", id);
    }

    @Test
    void searchIsPublicForAllRolesAndOldArrayAndDetailRemainCompatible() throws Exception {
        long id = createActivity(marker() + " public", "Venue", 2);
        for (String name : List.of("guest", "demo", "admin")) {
            var search = get("/api/activities/search");
            var old = get("/api/activities");
            var detail = get("/api/activities/" + id);
            if (!name.equals("guest")) {
                search.with(user(principal(name)));
                old.with(user(principal(name)));
                detail.with(user(principal(name)));
            }
            mvc.perform(search).andExpect(status().isOk()).andExpect(jsonPath("$.items").isArray())
                .andExpect(jsonPath("$.total").isNumber()).andExpect(jsonPath("$.page").value(1))
                .andExpect(jsonPath("$.pageSize").value(12)).andExpect(jsonPath("$.summary.upcomingActivities").isNumber())
                .andExpect(jsonPath("$.summary.availableSeats").isNumber());
            mvc.perform(old).andExpect(status().isOk()).andExpect(jsonPath("$").isArray())
                .andExpect(jsonPath("$.items").doesNotExist());
            mvc.perform(detail).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));
        }
    }

    @Test
    void keywordMatchesTitleAndLocationLiterallyIncludingSpacesAndSqlCharacters() throws Exception {
        String prefix = marker();
        long percent = createActivity(prefix + " 50%", "Venue", 2);
        createActivity(prefix + " 500", "Venue", 2);
        long underscore = createActivity(prefix + " room_A", "Venue", 2);
        createActivity(prefix + " roomXA", "Venue", 2);
        long slash = createActivity(prefix + " C:\\hall", "Venue", 2);
        createActivity(prefix + " Chall", "Venue", 2);
        long place = createActivity("Place " + UUID.randomUUID(), prefix + " location%_", 2);
        long spaces = createActivity(prefix + " two  spaces", "Venue", 2);
        assertIds(prefix + " 50%", percent);
        assertIds(prefix + " room_A", underscore);
        assertIds(prefix + " C:\\hall", slash);
        assertIds(prefix + " location%_", place);
        assertIds(prefix + " two  spaces", spaces);
        assertIds(" " + prefix + " two  spaces ");
        mvc.perform(get("/api/activities/search").param("keyword", "x' OR 1=1 --"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0))
            .andExpect(jsonPath("$.items").isEmpty()).andExpect(jsonPath("$.summary.upcomingActivities").value(0))
            .andExpect(jsonPath("$.summary.availableSeats").value(0));
    }

    @Test
    void allSixStatesUseExactBoundaryAndNeverCountCancelledAsStartedOrUpcoming() throws Exception {
        String prefix = marker();
        long open = createActivity(prefix + " open", "Venue", 4);
        registrations.register(open, createUser());
        long full = createActivity(prefix + " full", "Venue", 1);
        registrations.register(full, createUser());
        long started = createActivity(prefix + " started", "Venue", 2);
        changeStart(started, NOW.minusSeconds(1));
        long boundary = createActivity(prefix + " boundary", "Venue", 3);
        changeStart(boundary, NOW.truncatedTo(ChronoUnit.MICROS));
        long nextMicrosecond = createActivity(prefix + " next microsecond", "Venue", 2);
        changeStart(nextMicrosecond, NOW.truncatedTo(ChronoUnit.MICROS).plus(1, ChronoUnit.MICROS));
        long cancelled = createActivity(prefix + " cancelled", "Venue", 9);
        activities.cancel(cancelled, new CancelActivityRequest("Fixture cancellation"), adminId());
        changeStart(cancelled, NOW.minusSeconds(2));

        assertState(prefix, "ALL", 6, 3, 5, cancelled, started, boundary, nextMicrosecond, open, full);
        assertState(prefix, "OPEN", 2, 2, 5, nextMicrosecond, open);
        assertState(prefix, "FULL", 1, 1, 0, full);
        assertState(prefix, "STARTED", 2, 0, 0, started, boundary);
        assertState(prefix, "UPCOMING", 3, 3, 5, nextMicrosecond, open, full);
        assertState(prefix, "CANCELLED", 1, 0, 0, cancelled);
        var all = activities.search(1, 100, prefix, "ALL", null);
        assertThat(all.items()).filteredOn(item -> item.id() == boundary).allMatch(ActivityView::closed);
        assertThat(all.items()).filteredOn(item -> item.id() == nextMicrosecond).noneMatch(ActivityView::closed);
        assertThat(all.items()).filteredOn(item -> item.id() == cancelled).allMatch(ActivityView::cancelled);
        for (String state : List.of("ALL", "OPEN", "FULL", "STARTED", "UPCOMING", "CANCELLED")) {
            assertThat(activities.search(1, 100, prefix, state, null).items()).extracting(ActivityView::id)
                .containsExactlyElementsOf(admin.activities(1, 100, prefix, state, adminId()).items().stream().map(ActivityView::id).toList());
        }
    }

    @Test
    void summaryCoversEveryMatchAcrossPagesAndStableSortDoesNotRepeatOrSkipItems() throws Exception {
        String prefix = marker();
        List<Long> expected = new ArrayList<>();
        for (int capacity : List.of(1, 2, 3, 4, 5)) expected.add(createActivity(prefix + " item " + capacity, "Venue", capacity));
        registrations.register(expected.get(1), createUser());
        List<Long> seen = new ArrayList<>();
        for (int page = 1; page <= 3; page++) {
            var result = activities.search(page, 2, prefix, "ALL", null);
            assertThat(result.total()).isEqualTo(5);
            assertThat(result.page()).isEqualTo(page);
            assertThat(result.pageSize()).isEqualTo(2);
            assertThat(result.summary()).isEqualTo(new ActivitySearchSummary(5, 14));
            seen.addAll(result.items().stream().map(ActivityView::id).toList());
        }
        assertThat(seen).containsExactlyElementsOf(expected).doesNotHaveDuplicates();
        mvc.perform(get("/api/activities/search").param("keyword", prefix).param("page", "3").param("pageSize", "2"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].id").value(expected.getLast())).andExpect(jsonPath("$.total").value(5))
            .andExpect(jsonPath("$.summary.availableSeats").value(14));
    }

    @Test
    void outsideLastPageAndMaximumIntegerKeepTotalsSummaryAndRequestedPage() throws Exception {
        String prefix = marker();
        createActivity(prefix, "Venue", 3);
        for (int page : List.of(2, Integer.MAX_VALUE)) {
            mvc.perform(get("/api/activities/search").param("keyword", prefix).param("page", Integer.toString(page)).param("pageSize", "100"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty()).andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.page").value(page)).andExpect(jsonPath("$.pageSize").value(100))
                .andExpect(jsonPath("$.summary.upcomingActivities").value(1)).andExpect(jsonPath("$.summary.availableSeats").value(3));
        }
    }

    @Test
    void registrationStatusComesOnlyFromAuthenticatedIdentity() throws Exception {
        String prefix = marker();
        long id = createActivity(prefix, "Venue", 1);
        long demoId = users.findByUsername("demo").id();
        registrations.register(id, demoId);
        registrations.register(id, adminId());
        mvc.perform(get("/api/activities/search").param("keyword", prefix).param("userId", Long.toString(demoId)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].registrationStatus").isEmpty());
        mvc.perform(get("/api/activities/search").with(user(principal("demo"))).param("keyword", prefix)
            .param("userId", Long.toString(adminId())))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].registrationStatus").value("ACTIVE"))
            .andExpect(jsonPath("$.items[0].waitingCount").value(1));
        mvc.perform(get("/api/activities/search").with(user(principal("admin"))).param("keyword", prefix)
            .param("userId", Long.toString(demoId)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].registrationStatus").value("WAITING"));
        registrations.cancel(id, demoId);
        mvc.perform(get("/api/activities/search").with(user(principal("demo"))).param("keyword", prefix))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].registrationStatus").value("CANCELLED"));
    }

    @Test
    void invalidOrMalformedConditionsReturnExistingValidationJson() throws Exception {
        for (String[] pair : List.of(new String[]{"page", "0"}, new String[]{"page", "-1"},
            new String[]{"pageSize", "0"}, new String[]{"pageSize", "101"}, new String[]{"pageSize", "-1"},
            new String[]{"page", "not-a-number"}, new String[]{"page", "2147483648"},
            new String[]{"pageSize", "1.5"}, new String[]{"keyword", "x".repeat(201)},
            new String[]{"status", "UNKNOWN"}, new String[]{"status", "open"}, new String[]{"status", "ACTIVE"})) {
            mvc.perform(get("/api/activities/search").param(pair[0], pair[1]))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        mvc.perform(get("/api/activities/search").param("keyword", "x".repeat(200)).param("pageSize", "1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty());
    }

    @Test
    void oneClockReadKeepsSqlAndResponseOnTheSameMicrosecondInstant() {
        String prefix = marker();
        long id = createActivity(prefix, "Venue", 2);
        changeStart(id, NOW.truncatedTo(ChronoUnit.MICROS).plus(1, ChronoUnit.MICROS));
        clock.calls.set(0);
        var page = activities.search(1, 12, prefix, "OPEN", null);
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(page.total()).isEqualTo(1);
        assertThat(page.items()).hasSize(1).allMatch(item -> !item.closed());
    }

    @Test
    void committedCancellationBetweenAggregateAndItemsDoesNotTearTheReadSnapshot() throws Exception {
        String prefix = marker();
        long id = createActivity(prefix, "Venue", 3);
        long member = createUser();
        registrations.register(id, member);
        try (var writer = Executors.newSingleThreadExecutor()) {
            reads.afterTotals.set(() -> {
                try {
                    var cancelled = writer.submit(() -> activities.cancel(id, new CancelActivityRequest("Concurrent fixture cancellation"), adminId()));
                    assertThat(cancelled.get(10, TimeUnit.SECONDS).cancelled()).isTrue();
                } catch (Exception exception) {
                    throw new AssertionError("Concurrent cancellation must commit before the page read", exception);
                }
            });
            var page = activities.search(1, 12, prefix, "OPEN", member);
            assertThat(reads.afterTotals.get()).isNull();
            assertThat(page.total()).isEqualTo(1);
            assertThat(page.summary()).isEqualTo(new ActivitySearchSummary(1, 2));
            assertThat(page.items()).hasSize(1).allSatisfy(item -> {
                assertThat(item.id()).isEqualTo(id);
                assertThat(item.cancelled()).isFalse();
                assertThat(item.closed()).isFalse();
                assertThat(item.registeredCount()).isEqualTo(1);
                assertThat(item.registrationStatus()).isEqualTo("ACTIVE");
            });
        }
        var nextRequest = activities.search(1, 12, prefix, "OPEN", member);
        assertThat(nextRequest.total()).isZero();
        assertThat(nextRequest.summary()).isEqualTo(new ActivitySearchSummary(0, 0));
        assertThat(nextRequest.items()).isEmpty();
        assertThat(activities.search(1, 12, prefix, "CANCELLED", member).items()).hasSize(1)
            .allMatch(item -> item.cancelled() && item.registeredCount() == 0 && item.registrationStatus().equals("CANCELLED"));
    }

    @Test
    void searchUsesItsOwnBoundedMetricRouteAndDoesNotLogKeyword(CapturedOutput output) throws Exception {
        String secret = "PRIVATE_SEARCH_" + UUID.randomUUID();
        long before = monitoring.snapshot().routes().stream().filter(route -> route.route().equals("/api/activities/search"))
            .mapToLong(route -> route.count()).sum();
        var response = mvc.perform(get("/api/activities/search").param("keyword", secret))
            .andExpect(status().isOk()).andReturn();
        assertThat(monitoring.snapshot().routes().stream().filter(route -> route.route().equals("/api/activities/search"))
            .mapToLong(route -> route.count()).sum()).isEqualTo(before + 1);
        String id = response.getResponse().getHeader("X-Request-Id");
        assertThat(UUID.fromString(id).toString()).isEqualTo(id);
        String line = output.getAll().lines().filter(value -> value.startsWith("{") && value.contains(id)
            && value.contains("http_request")).findFirst().orElseThrow();
        assertThat(json.readTree(line).get("route").asString()).isEqualTo("/api/activities/search");
        assertThat(line).doesNotContain(secret);
    }

    private void assertIds(String keyword, Long... expected) {
        assertThat(activities.search(1, 100, keyword, "ALL", null).items()).extracting(ActivityView::id).containsExactly(expected);
    }

    private void assertState(String keyword, String state, long total, long upcoming, long seats, Long... expected) {
        var page = activities.search(1, 100, keyword, state, null);
        assertThat(page.total()).isEqualTo(total);
        assertThat(page.summary()).isEqualTo(new ActivitySearchSummary(upcoming, seats));
        assertThat(page.items()).extracting(ActivityView::id).containsExactly(expected);
    }

    private long createActivity(String title, String location, int capacity) {
        var activity = activities.create(new CreateActivityRequest(title, "Search fixture", location, NOW.plusSeconds(3600), capacity), adminId());
        activityIds.add(activity.id());
        return activity.id();
    }

    private long createUser() {
        String username = "search_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Search fixture", "USER");
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private static String marker() { return "Search" + UUID.randomUUID().toString().replace("-", ""); }
    private void changeStart(long id, Instant start) { jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", LocalDateTime.ofInstant(start, ZoneOffset.UTC), id); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(String name) { return new AppUserDetails(users.findByUsername(name)); }
}

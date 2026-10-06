package com.example.gather;

import com.example.gather.api.AdminModels.OverviewView;
import com.example.gather.api.ApiModels.CreateActivityRequest;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.RegistrationService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@Import(AdminIntegrationTest.FixedTimeConfiguration.class)
class AdminIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-01-10T09:00:00Z");

    @TestConfiguration(proxyBeanMethods = false)
    static class FixedTimeConfiguration {
        @Bean
        @Primary
        Clock adminTestClock() { return Clock.fixed(NOW, ZoneOffset.UTC); }
    }

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
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired AdminService admin;
    private final List<Long> activityIds = new ArrayList<>();
    private final List<Long> userIds = new ArrayList<>();

    @AfterEach
    void cleanOnlyCreatedFixtures() {
        for (long id : activityIds) {
            jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
            jdbc.update("DELETE FROM activities WHERE id=?", id);
        }
        for (long id : userIds) jdbc.update("DELETE FROM users WHERE id=?", id);
    }

    @Test
    void allThreeAdminQueriesRequireAdminRole() throws Exception {
        long id = createActivity("Permission " + UUID.randomUUID(), "Venue", 2);
        for (String path : List.of("/api/admin/overview", "/api/admin/activities", "/api/admin/activities/" + id + "/registrations")) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
            mvc.perform(get(path).with(user(principal("demo"))))
                .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("FORBIDDEN"));
            mvc.perform(get(path).with(user(principal("admin")))).andExpect(status().isOk());
        }
        // The roster never becomes a public activity subresource.
        mvc.perform(get("/api/activities/" + id + "/registrations")).andExpect(status().isUnauthorized());
    }

    @Test
    void overviewUsesRealStatusesIncludesStartedRegistrationsAndOneExactBoundary() throws Exception {
        OverviewView before = admin.overview();
        createActivity("Open " + UUID.randomUUID(), "Venue", 4);
        long full = createActivity("Full " + UUID.randomUUID(), "Venue", 2);
        registrations.register(full, createUser());
        registrations.register(full, createUser());
        long boundary = createActivity("Boundary " + UUID.randomUUID(), "Venue", 3);
        registrations.register(boundary, createUser());
        changeStart(boundary, NOW);
        long startedFull = createActivity("Started full " + UUID.randomUUID(), "Venue", 1);
        registrations.register(startedFull, createUser());
        changeStart(startedFull, NOW.minusSeconds(1));
        long cancelled = createActivity("Cancelled " + UUID.randomUUID(), "Venue", 3);
        long cancelledUser = createUser();
        registrations.register(cancelled, cancelledUser);
        registrations.cancel(cancelled, cancelledUser);

        OverviewView after = admin.overview();
        assertThat(after.totalActivities() - before.totalActivities()).isEqualTo(5);
        assertThat(after.upcomingActivities() - before.upcomingActivities()).isEqualTo(3);
        assertThat(after.startedActivities() - before.startedActivities()).isEqualTo(2);
        assertThat(after.fullActivities() - before.fullActivities()).isEqualTo(1);
        assertThat(after.activeRegistrations() - before.activeRegistrations()).isEqualTo(4);
        assertThat(after.availableSeats() - before.availableSeats()).isEqualTo(7);
        assertThat(after.upcomingActivities() + after.startedActivities()).isEqualTo(after.totalActivities());
        mvc.perform(get("/api/admin/overview").with(user(principal("admin"))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.totalActivities").value(after.totalActivities()))
            .andExpect(jsonPath("$.upcomingActivities").value(after.upcomingActivities()))
            .andExpect(jsonPath("$.startedActivities").value(after.startedActivities()))
            .andExpect(jsonPath("$.fullActivities").value(after.fullActivities()))
            .andExpect(jsonPath("$.activeRegistrations").value(after.activeRegistrations()))
            .andExpect(jsonPath("$.availableSeats").value(after.availableSeats()));
    }

    @Test
    void activityFiltersAndPaginationKeepStableStartThenIdOrder() throws Exception {
        String prefix = "Filter" + UUID.randomUUID().toString().replace("-", "");
        long openFirst = createActivity(prefix + " first", "Venue", 2);
        long full = createActivity(prefix + " full", "Venue", 1);
        registrations.register(full, createUser());
        long openSecond = createActivity(prefix + " second", "Venue", 3);
        long past = createActivity(prefix + " past", "Venue", 1);
        changeStart(past, NOW.minusSeconds(1));
        long boundary = createActivity(prefix + " boundary", "Venue", 1);
        changeStart(boundary, NOW);
        long adminId = users.findByUsername("admin").id();

        assertThat(admin.activities(1, 100, prefix, "ALL", adminId).items()).extracting(item -> item.id())
            .containsExactly(past, boundary, openFirst, full, openSecond);
        assertThat(admin.activities(1, 100, prefix, "OPEN", adminId).items()).extracting(item -> item.id()).containsExactly(openFirst, openSecond);
        assertThat(admin.activities(1, 100, prefix, "FULL", adminId).items()).extracting(item -> item.id()).containsExactly(full);
        assertThat(admin.activities(1, 100, prefix, "STARTED", adminId).items()).extracting(item -> item.id()).containsExactly(past, boundary);
        assertThat(admin.activities(1, 100, prefix, "UPCOMING", adminId).items()).extracting(item -> item.id()).containsExactly(openFirst, full, openSecond);
        mvc.perform(get("/api/admin/activities").with(user(principal("admin")))
            .param("keyword", prefix).param("page", "2").param("pageSize", "2"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(5))
            .andExpect(jsonPath("$.page").value(2)).andExpect(jsonPath("$.pageSize").value(2))
            .andExpect(jsonPath("$.items[0].id").value(openFirst)).andExpect(jsonPath("$.items[1].id").value(full))
            .andExpect(jsonPath("$.items[0].closed").value(false));
        mvc.perform(get("/api/admin/activities").with(user(principal("admin")))
            .param("keyword", prefix).param("page", "4").param("pageSize", "2"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(5)).andExpect(jsonPath("$.items").isEmpty());
        mvc.perform(get("/api/admin/activities").with(user(principal("admin")))
            .param("keyword", prefix).param("page", "2147483647").param("pageSize", "100"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty()).andExpect(jsonPath("$.total").value(5));
    }

    @Test
    void searchTreatsPercentUnderscoreBackslashAndQuotesAsLiteralSubstrings() throws Exception {
        String prefix = "Literal" + UUID.randomUUID().toString().replace("-", "");
        long percent = createActivity(prefix + " 50%", "Venue", 2);
        createActivity(prefix + " 500", "Venue", 2);
        long underscore = createActivity(prefix + " room_A", "Venue", 2);
        createActivity(prefix + " roomXA", "Venue", 2);
        long slash = createActivity(prefix + " C:\\hall", "Venue", 2);
        createActivity(prefix + " Chall", "Venue", 2);
        long location = createActivity("Location " + UUID.randomUUID(), prefix + " location%_", 2);
        long adminId = users.findByUsername("admin").id();
        assertThat(admin.activities(1, 100, prefix + " 50%", "ALL", adminId).items()).extracting(item -> item.id()).containsExactly(percent);
        assertThat(admin.activities(1, 100, prefix + " room_A", "ALL", adminId).items()).extracting(item -> item.id()).containsExactly(underscore);
        assertThat(admin.activities(1, 100, prefix + " C:\\hall", "ALL", adminId).items()).extracting(item -> item.id()).containsExactly(slash);
        assertThat(admin.activities(1, 100, prefix + " location%_", "ALL", adminId).items()).extracting(item -> item.id()).containsExactly(location);
        mvc.perform(get("/api/admin/activities").with(user(principal("admin"))).param("keyword", "x' OR 1=1 --"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0)).andExpect(jsonPath("$.items").isEmpty());
    }

    @Test
    void invalidPageSizesKeywordsStatusesAndMalformedParametersReturnJson400() throws Exception {
        long id = createActivity("Validation " + UUID.randomUUID(), "Venue", 1);
        for (String path : List.of("/api/admin/activities", "/api/admin/activities/" + id + "/registrations")) {
            for (String[] parameter : List.of(new String[]{"page", "0"}, new String[]{"page", "-1"},
                new String[]{"pageSize", "0"}, new String[]{"pageSize", "101"}, new String[]{"page", "not-a-number"},
                new String[]{"status", "UNKNOWN"}, new String[]{"status", "active"})) {
                mvc.perform(get(path).with(user(principal("admin"))).param(parameter[0], parameter[1]))
                    .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            }
        }
        mvc.perform(get("/api/admin/activities").with(user(principal("admin"))).param("keyword", "x".repeat(201)))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        mvc.perform(get("/api/admin/activities").with(user(principal("admin"))).param("status", "ACTIVE"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        mvc.perform(get("/api/admin/activities/" + id + "/registrations").with(user(principal("admin"))).param("status", "OPEN"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
    }

    @Test
    void rosterIncludesCancelledUsersWithStableOrderPaginationAndUtcTimestamps() throws Exception {
        long id = createActivity("Roster " + UUID.randomUUID(), "Venue", 5);
        long first = createUser();
        long cancelled = createUser();
        long third = createUser();
        registrations.register(id, first);
        registrations.register(id, cancelled);
        registrations.cancel(id, cancelled);
        registrations.register(id, third);
        Instant created = NOW.minusSeconds(3600).plusNanos(123456000);
        Instant earlierUpdate = NOW.minusSeconds(120);
        Instant lastUpdate = NOW.minusSeconds(60);
        jdbc.update("UPDATE registrations SET created_at=?, updated_at=? WHERE activity_id=?", utc(created), utc(earlierUpdate), id);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id=?", utc(lastUpdate), id, cancelled);
        long adminId = users.findByUsername("admin").id();
        var all = admin.roster(id, 1, 10, "ALL", adminId);
        assertThat(all.total()).isEqualTo(3);
        assertThat(all.activity().registeredCount()).isEqualTo(2);
        assertThat(all.items()).extracting(item -> item.userId()).containsExactly(cancelled, third, first);
        assertThat(all.items()).extracting(item -> item.createdAt()).containsOnly(created);
        assertThat(admin.roster(id, 1, 10, "ACTIVE", adminId).items()).extracting(item -> item.userId()).containsExactly(third, first);
        assertThat(admin.roster(id, 1, 10, "CANCELLED", adminId).items()).extracting(item -> item.userId()).containsExactly(cancelled);
        mvc.perform(get("/api/admin/activities/" + id + "/registrations").with(user(principal("admin")))
            .param("page", "2").param("pageSize", "1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(3))
            .andExpect(jsonPath("$.activity.id").value(id)).andExpect(jsonPath("$.activity.registeredCount").value(2))
            .andExpect(jsonPath("$.items[0].userId").value(third)).andExpect(jsonPath("$.items[0].status").value("ACTIVE"))
            .andExpect(jsonPath("$.items[0].username").value(username(third)))
            .andExpect(jsonPath("$.items[0].displayName").value("Admin query test user"))
            .andExpect(jsonPath("$.items[0].createdAt").value("2035-01-10T08:00:00.123456Z"))
            .andExpect(jsonPath("$.items[0].updatedAt").value("2035-01-10T08:58:00Z"))
            .andExpect(jsonPath("$.items[0].passwordHash").doesNotExist());
    }

    @Test
    void emptyRosterAndPastLastPageRetainActivityWhileMissingActivityReturns404() throws Exception {
        long id = createActivity("Empty " + UUID.randomUUID(), "Venue", 2);
        mvc.perform(get("/api/admin/activities/" + id + "/registrations").with(user(principal("admin"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.activity.id").value(id))
            .andExpect(jsonPath("$.total").value(0)).andExpect(jsonPath("$.items").isEmpty())
            .andExpect(jsonPath("$.page").value(1)).andExpect(jsonPath("$.pageSize").value(10));
        registrations.register(id, createUser());
        mvc.perform(get("/api/admin/activities/" + id + "/registrations").with(user(principal("admin")))
            .param("page", "2").param("pageSize", "1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.activity.id").value(id))
            .andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items").isEmpty());
        mvc.perform(get("/api/admin/activities/9223372036854775807/registrations").with(user(principal("admin"))))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("ACTIVITY_NOT_FOUND"));
    }

    private long createActivity(String title, String location, int capacity) {
        var activity = activities.create(new CreateActivityRequest(title, "Admin query fixture", location,
            NOW.plusSeconds(3600), capacity), users.findByUsername("admin").id());
        activityIds.add(activity.id());
        return activity.id();
    }

    private long createUser() {
        String username = "admin_test_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "Admin query test user", "USER");
        long id = users.findByUsername(username).id();
        userIds.add(id);
        return id;
    }

    private void changeStart(long id, Instant instant) { jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(instant), id); }
    private static LocalDateTime utc(Instant instant) { return LocalDateTime.ofInstant(instant, ZoneOffset.UTC); }
    private AppUserDetails principal(String username) { return new AppUserDetails(users.findByUsername(username)); }
    private String username(long id) { return jdbc.queryForObject("SELECT username FROM users WHERE id=?", String.class, id); }
}

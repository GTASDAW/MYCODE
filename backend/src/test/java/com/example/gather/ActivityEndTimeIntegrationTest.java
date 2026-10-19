package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.api.AdminModels.RosterView;
import com.example.gather.api.AuditLogModels.AuditChange;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.*;
import com.example.gather.support.OwnedIntegrationFixtures;
import com.example.gather.support.OwnedIntegrationFixtures.FavoriteKey;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.*;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Dedicated real MySQL: microsecond boundaries, additive API compatibility and late check-in. */
@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ActivityEndTimeIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ActivityEndTimeIntegrationTest {
    static final Instant NOW = Instant.parse("2046-10-01T09:00:00.123456Z");
    static final Instant START = NOW.plusSeconds(3600);
    static final Instant END = START.plusSeconds(3600);

    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return time.get(); }
    }
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary MutableClock endTimeClock() { return new MutableClock(); }
        @Bean EndTimeQueries endTimeQueries() { return new EndTimeQueries(); }
    }
    @Intercepts({@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})})
    static class EndTimeQueries implements Interceptor {
        final AtomicBoolean failAudit = new AtomicBoolean();
        final AtomicBoolean failPromotion = new AtomicBoolean();
        final AtomicReference<CountDownLatch> beforeLock = new AtomicReference<>();
        final AtomicReference<Runnable> afterTotals = new AtomicReference<>();
        final ThreadLocal<List<SnapshotRead>> captured = new ThreadLocal<>();
        final List<String> lockSql = new CopyOnWriteArrayList<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (statement.getId().endsWith("AuditLogMapper.insert") && failAudit.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected end time audit failure");
            if (statement.getId().endsWith("NotificationMapper.insertPromotion") && failPromotion.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected deadline promotion failure");
            if (statement.getId().endsWith("ActivityMapper.lockById")) {
                lockSql.add(statement.getBoundSql(invocation.getArgs()[1]).getSql());
                var latch = beforeLock.getAndSet(null); if (latch != null) latch.countDown();
            }
            if (captured.get() != null && invocation.getMethod().getName().equals("query")) {
                Object input = invocation.getArgs()[1];
                captured.get().add(new SnapshotRead(statement.getId(), input instanceof Map<?, ?> map ? (LocalDateTime) map.get("now") : null,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(), TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            Object result = invocation.proceed();
            if (statement.getId().endsWith("ActivityMapper.searchTotals")) {
                var action = afterTotals.getAndSet(null); if (action != null) action.run();
            }
            return result;
        }
    }
    record SnapshotRead(String statement, LocalDateTime now, boolean readOnly, Integer isolation) {}
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("End time tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"), "activity"));
        properties.add("spring.datasource.password", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"), "activity_dev_password"));
        properties.add("app.demo-seed-enabled", () -> "true");
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired UserMapper users;
    @Autowired ActivityMapper mapper;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired FavoriteService favorites;
    @Autowired CheckInService checkIns;
    @Autowired AuditLogService audit;
    @Autowired AdminService admin;
    @Autowired MutableClock clock;
    @Autowired EndTimeQueries queries;
    final Map<Long, String> fixtureActivities = new LinkedHashMap<>();
    final Map<Long, String> fixtureUsers = new LinkedHashMap<>();
    final List<FavoriteKey> favoriteKeys = new ArrayList<>();
    final String prefix = "End time " + UUID.randomUUID();

    @BeforeEach void gate() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(12);
        jdbc.queryForList("SELECT id,category,cover_hash,cover_image,ends_at,registration_deadline FROM activities LIMIT 0");
        clock.time.set(NOW);
    }
    @AfterEach void cleanup() {
        clock.time.set(NOW); queries.failAudit.set(false); queries.failPromotion.set(false); queries.beforeLock.set(null);
        queries.afterTotals.set(null); queries.captured.remove(); queries.lockSql.clear();
        fixtureActivities.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        fixtureUsers.forEach((id, username) -> assertThat(users.findById(id).username()).isEqualTo(username));
        OwnedIntegrationFixtures.remove(jdbc, fixtureActivities.keySet(), fixtureUsers.keySet(), favoriteKeys);
    }

    @Test void migrationHasNullableMicrosecondsAndDatabaseConstraintWithoutInventingAnEnd() {
        var columns = jdbc.queryForMap("SELECT IS_NULLABLE, DATETIME_PRECISION FROM information_schema.COLUMNS "
            + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='activities' AND COLUMN_NAME='ends_at'");
        assertThat(columns.get("IS_NULLABLE")).isEqualTo("YES");
        assertThat(((Number) columns.get("DATETIME_PRECISION")).intValue()).isEqualTo(6);
        var legacy = new NewActivity(prefix, "Legacy request fixture", "会场", utc(START), 2, adminId());
        mapper.insert(legacy); fixtureActivities.put(legacy.id, legacy.title);
        assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        for (Instant invalid : List.of(START, START.minusNanos(1000))) {
            assertThatThrownBy(() -> jdbc.update("UPDATE activities SET ends_at=? WHERE id=?", utc(invalid), legacy.id))
                .isInstanceOf(DataAccessException.class);
            assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        }
        jdbc.update("UPDATE activities SET ends_at=? WHERE id=?", utc(START.plusNanos(1000)), legacy.id);
        assertThat(activities.get(legacy.id, null).endsAt()).isEqualTo(START.plusNanos(1000));
        jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?", legacy.id);
        clock.time.set(END.plusSeconds(1));
        assertThat(activities.get(legacy.id, null).endsAt()).isNull();
        assertThat(activities.get(legacy.id, null).closed()).isTrue();
    }

    @Test void oldRequestsWithMissingOrExplicitNullEndKeepLegacyFieldsAndNullEndInEveryProjection() throws Exception {
        long member = account();
        for (boolean explicitNull : List.of(false, true)) {
            var body = body(prefix + " null " + explicitNull, START.toString());
            if (explicitNull) body.put("endsAt", null);
            long id = postActivity(body);
            assertThat(activities.get(id, null).endsAt()).isNull();
            assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
            assertThat(activities.get(id, null).capacity()).isEqualTo(2);
            assertProjectionEnds(id, member, null);
            assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
                .contains(new AuditChange("endsAt", null, null));
        }
    }

    @Test void invalidEndAndSubMicrosecondEqualityFailBeforeWritingActivityOrAudit() throws Exception {
        for (Instant invalid : List.of(START.minusSeconds(1), START, START.plusNanos(999))) {
            String title = prefix + " invalid " + invalid;
            var body = body(title, START.toString()); body.put("endsAt", invalid.toString());
            mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_title=?", Integer.class, title)).isZero();
        }
        var minimum = body(prefix + " first microsecond", START.plusNanos(700).toString());
        minimum.put("endsAt", START.plusNanos(1000).toString());
        long id = postActivity(minimum);
        assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
        assertThat(activities.get(id, null).endsAt()).isEqualTo(START.plusNanos(1000));
    }

    @Test void offsetInputPersistsAndAuditsExactlyTheUtcMicrosecondsAcrossAllJoinedResponses() throws Exception {
        var body = body(prefix + " offsets", START.atOffset(ZoneOffset.ofHours(8)).toString());
        body.put("endsAt", END.plusNanos(987).atOffset(ZoneOffset.ofHours(-5)).toString());
        long id = postActivity(body);
        assertThat(activities.get(id, null).startsAt()).isEqualTo(START);
        assertThat(activities.get(id, null).endsAt()).isEqualTo(END);
        assertThat(jdbc.queryForObject("SELECT ends_at FROM activities WHERE id=?", LocalDateTime.class, id)).isEqualTo(utc(END));
        assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
            .contains(new AuditChange("startsAt", null, START.toString()), new AuditChange("endsAt", null, END.toString()));
        assertProjectionEnds(id, account(), END);
    }

    @Test void createStillRequiresAdminAndCsrfAndNeverTrustsClientIdentity() throws Exception {
        String title = prefix + " permission";
        var body = body(title, START.toString()); body.put("endsAt", END.toString()); body.put("registrationDeadline", NOW.plusSeconds(60).toString());
        String text = json.writeValueAsString(body); long member = account();
        mvc.perform(post("/api/admin/activities").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(text)).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/admin/activities").with(user(principal(member))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(text)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).contentType(MediaType.APPLICATION_JSON).content(text))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        body.put("createdBy", member);
        long id = postActivity(body);
        assertThat(jdbc.queryForObject("SELECT created_by FROM activities WHERE id=?", Long.class, id)).isEqualTo(adminId());
    }

    @Test void endRemainsFixedDuringEditAndCancelAndRepeatedCancellation() throws Exception {
        long id = activity(END);
        var edit = new LinkedHashMap<String, Object>();
        edit.put("title", fixtureActivities.get(id)); edit.put("description", "New description"); edit.put("location", "新会场");
        edit.put("endsAt", END.plusSeconds(9999).toString()); edit.put("startsAt", START.plusSeconds(60).toString());
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(edit)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.endsAt").value(END.toString())).andExpect(jsonPath("$.startsAt").value(START.toString()));
        var first = activities.cancel(id, new CancelActivityRequest("原始取消原因"), adminId());
        clock.time.set(END.plusSeconds(1));
        var repeated = activities.cancel(id, new CancelActivityRequest("后来的取消原因"), adminId());
        assertThat(repeated).isEqualTo(first);
        assertThat(repeated.endsAt()).isEqualTo(END);
        assertThat(repeated.cancelled()).isTrue();
        assertThat(audit.search(1, 10, "CANCEL", id).total()).isEqualTo(1);
    }

    @Test void startedFilterAndClosedBoundaryStayCompatibleAndEndedActivityAllowsIdempotentAdminCheckIn() throws Exception {
        long id = activity(END), member = account(), other = account();
        registrations.register(id, member);
        long registration = jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, id, member);
        String checkIn = "/api/admin/activities/" + id + "/registrations/" + registration + "/check-in";
        clock.time.set(START.minusNanos(1));
        assertThat(activities.get(id, null).closed()).isFalse();
        mvc.perform(post(checkIn).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("CHECK_IN_NOT_OPEN"));
        clock.time.set(START);
        assertThat(activities.get(id, null).closed()).isTrue();
        assertThat(activities.search(1, 10, prefix, "STARTED", null).items()).extracting(ActivityView::id).containsExactly(id);
        mvc.perform(post("/api/activities/" + id + "/registration").with(user(principal(other))).with(csrf()))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CLOSED"));
        clock.time.set(END.plusSeconds(86400));
        assertThat(activities.search(1, 10, prefix, "STARTED", null).items()).extracting(ActivityView::id).containsExactly(id);
        mvc.perform(post(checkIn).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(post(checkIn).with(user(principal(member))).with(csrf())).andExpect(status().isForbidden());
        mvc.perform(post(checkIn).with(user(principal(adminId())))).andExpect(status().isForbidden());
        var before = jdbc.queryForMap("SELECT status,updated_at FROM registrations WHERE id=?", registration);
        var first = json.readValue(mvc.perform(post(checkIn).with(user(principal(adminId()))).with(csrf()))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(), RosterView.class);
        clock.time.set(END.plusSeconds(172800));
        assertThat(checkIns.checkIn(id, registration, adminId())).isEqualTo(first);
        assertThat(first.checkedInAt()).isEqualTo(END.plusSeconds(86400));
        assertThat(jdbc.queryForMap("SELECT status,updated_at FROM registrations WHERE id=?", registration)).isEqualTo(before);
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(activities.get(id, null).waitingCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        assertThat(audit.search(1, 10, "CHECK_IN", id).total()).isEqualTo(1);
        assertThat(queries.lockSql).isNotEmpty().allSatisfy(sql -> assertThat(sql.toLowerCase(Locale.ROOT))
            .contains("for update").doesNotContain("ends_at", "description", "cover_image"));
    }

    @Test void auditFailureRollsBackNewEndTimeActivityInTheSameTransaction() {
        String title = prefix + " rollback"; queries.failAudit.set(true);
        assertThatThrownBy(() -> activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, 2, "TECHNOLOGY", END), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_title=?", Integer.class, title)).isZero();
    }

    @Test void deadlineCreationUsesUtcMicrosecondsRejectsExactAndNanosecondEdgesAndPreservesOldRequests() throws Exception {
        for (Instant invalid : List.of(NOW.minusSeconds(60), NOW.minusNanos(1000), NOW, NOW.plusNanos(999), START, START.plusNanos(1000), START.plusSeconds(60))) {
            String title = prefix + " invalid deadline " + invalid;
            var body = body(title, START.toString()); body.put("registrationDeadline", invalid.toString());
            mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
        }
        for (Instant valid : List.of(NOW.plusNanos(1000), START.minusNanos(1000), NOW.plusSeconds(60))) {
            var body = body(prefix + " valid deadline " + valid, START.toString());
            body.put("registrationDeadline", valid.plusNanos(999).atOffset(ZoneOffset.ofHours(8)).toString());
            long id = postActivity(body);
            assertThat(activities.get(id, null).registrationDeadline()).isEqualTo(valid);
            assertThat(jdbc.queryForObject("SELECT registration_deadline FROM activities WHERE id=?", LocalDateTime.class, id)).isEqualTo(utc(valid));
            assertThat(audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id()).changes())
                .contains(new AuditChange("registrationDeadline", null, valid.toString()));
        }
        for (boolean explicitNull : List.of(false, true)) {
            var body = body(prefix + " legacy deadline " + explicitNull, START.toString()); if (explicitNull) body.put("registrationDeadline", null);
            long id = postActivity(body); assertThat(activities.get(id, null).registrationDeadline()).isNull();
            assertThat(activities.get(id, null).registrationClosed()).isFalse();
        }
    }

    @Test void databaseDeadlineConstraintIsNullableAndStrictlyBeforeStartWithoutBackfill() {
        long id = activity(END);
        assertThat(activities.get(id, null).registrationDeadline()).isNull();
        for (Instant invalid : List.of(START, START.plusNanos(1000)))
            assertThatThrownBy(() -> jdbc.update("UPDATE activities SET registration_deadline=? WHERE id=?", utc(invalid), id)).isInstanceOf(DataAccessException.class);
        jdbc.update("UPDATE activities SET registration_deadline=? WHERE id=?", utc(START.minusNanos(1000)), id);
        assertThat(activities.get(id, null).registrationDeadline()).isEqualTo(START.minusNanos(1000));
        jdbc.update("UPDATE activities SET registration_deadline=NULL WHERE id=?", id);
        var column = jdbc.queryForMap("SELECT IS_NULLABLE,DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='activities' AND COLUMN_NAME='registration_deadline'");
        assertThat(column.get("IS_NULLABLE")).isEqualTo("YES"); assertThat(((Number) column.get("DATETIME_PRECISION")).intValue()).isEqualTo(6);
    }

    @Test void exactDeadlineRejectsFreshWaitingRejoinAndDuplicateWithoutChangingRowsButCancellationStillPromotesFifo() {
        Instant deadline = NOW.plusSeconds(60); long id = deadlineActivity(deadline, 1);
        long active = account(), first = account(), second = account(), cancelled = account(), fresh = account();
        registrations.register(id, active); registrations.register(id, first); registrations.register(id, second); registrations.register(id, cancelled); registrations.cancel(id, cancelled);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id=?", utc(NOW.minusSeconds(2)), id, first);
        jdbc.update("UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id=?", utc(NOW.minusSeconds(1)), id, second);
        clock.time.set(deadline.minusNanos(1000)); assertThat(registrations.register(id, first).registrationStatus()).isEqualTo("WAITING");
        var before = deadlineState(id);
        for (Instant time : List.of(deadline, deadline.plusNanos(1000), deadline.plusSeconds(60))) {
            clock.time.set(time);
            for (long member : List.of(active, first, second, cancelled, fresh))
                assertThatThrownBy(() -> registrations.register(id, member)).isInstanceOfSatisfying(com.example.gather.api.ApiException.class,
                    error -> assertThat(error.code()).isEqualTo("REGISTRATION_CLOSED"));
            assertThat(deadlineState(id)).isEqualTo(before);
            assertThat(activities.get(id, null).closed()).isFalse(); assertThat(activities.get(id, null).registrationClosed()).isTrue();
        }
        registrations.cancel(id, active);
        assertThat(activities.get(id, first).registrationStatus()).isEqualTo("ACTIVE"); assertThat(activities.get(id, second).registrationStatus()).isEqualTo("WAITING");
        assertThat(activities.get(id, null).registeredCount()).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT user_id FROM notifications WHERE activity_id=? AND type='PROMOTED'", Long.class, id)).containsExactly(first);
        registrations.cancel(id, active); assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isEqualTo(1);
        registrations.cancel(id, second); assertThat(activities.get(id, null).waitingCount()).isZero();
        clock.time.set(START);
        assertThatThrownBy(() -> registrations.register(id, fresh)).isInstanceOfSatisfying(com.example.gather.api.ApiException.class, error -> assertThat(error.code()).isEqualTo("ACTIVITY_CLOSED"));
        assertThatThrownBy(() -> registrations.cancel(id, first)).isInstanceOfSatisfying(com.example.gather.api.ApiException.class, error -> assertThat(error.code()).isEqualTo("ACTIVITY_CLOSED"));
    }

    @Test void realLockWaitCrossesDeadlineBeforeGuardAndConcurrentContendersAtDeadlineNeverEnter() throws Exception {
        Instant deadline = NOW.plusSeconds(60); long id = deadlineActivity(deadline, 1), member = account();
        try (var connection = Objects.requireNonNull(jdbc.getDataSource()).getConnection(); var executor = Executors.newFixedThreadPool(4)) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("SELECT id FROM activities WHERE id=? FOR UPDATE")) { lock.setLong(1, id); lock.executeQuery().close(); }
            var reached = new CountDownLatch(1); queries.beforeLock.set(reached); clock.time.set(deadline.minusNanos(1000));
            var pending = executor.submit(() -> registrations.register(id, member));
            assertThat(reached.await(5, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> pending.get(150, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            clock.time.set(deadline); connection.commit();
            assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class).hasCauseInstanceOf(com.example.gather.api.ApiException.class)
                .satisfies(error -> assertThat(((com.example.gather.api.ApiException) error.getCause()).code()).isEqualTo("REGISTRATION_CLOSED"));
            var outcomes = new ArrayList<Future<String>>();
            for (int index = 0; index < 6; index++) { long contender = account(); outcomes.add(executor.submit(() -> {
                try { registrations.register(id, contender); return "unexpected success"; }
                catch (com.example.gather.api.ApiException failure) { return failure.code(); }
            })); }
            for (var outcome : outcomes) assertThat(outcome.get(5, TimeUnit.SECONDS)).isEqualTo("REGISTRATION_CLOSED");
        }
        assertThat(activities.get(id, null).registeredCount()).isZero(); assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=?", Integer.class, id)).isZero();
        assertThat(queries.lockSql).allSatisfy(sql -> assertThat(sql.toLowerCase(Locale.ROOT)).contains("registration_deadline", "for update").doesNotContain("ends_at", "cover_image", "description"));
    }

    @Test void deadlineDoesNotBlockEditCancelOrCheckInAndPromotionFailureRollsBackAllRows() {
        Instant deadline = NOW.plusSeconds(60); long id = deadlineActivity(deadline, 1), first = account(), waiting = account();
        registrations.register(id, first); registrations.register(id, waiting); clock.time.set(deadline);
        var before = deadlineState(id); queries.failPromotion.set(true);
        assertThatThrownBy(() -> registrations.cancel(id, first)).isInstanceOf(DataAccessException.class);
        assertThat(deadlineState(id)).isEqualTo(before);
        activities.edit(id, new EditActivityRequest(fixtureActivities.get(id), "New text after deadline", "New venue"), adminId());
        assertThat(activities.get(id, null).registrationDeadline()).isEqualTo(deadline);
        registrations.cancel(id, first); clock.time.set(START);
        long registration = jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, id, waiting);
        assertThat(checkIns.checkIn(id, registration, adminId()).checkedInAt()).isEqualTo(START);
        clock.time.set(NOW); long cancelled = deadlineActivity(deadline, 1); clock.time.set(deadline);
        assertThat(activities.cancel(cancelled, new CancelActivityRequest("Cancel after deadline"), adminId()).cancelled()).isTrue();
    }

    @Test void deadlineAppearsInEveryProjectionAndCannotBeEditedThroughExtraJson() throws Exception {
        Instant deadline = NOW.plusSeconds(60); long id = deadlineActivity(deadline, 2), member = account();
        assertProjectionEnds(id, member, END);
        registrations.register(id, member); favorites.add(member, id); clock.time.set(deadline);
        var views = new ArrayList<ActivityView>(); views.add(activities.get(id, null)); views.addAll(activities.list(null));
        views.addAll(activities.search(1, 100, fixtureActivities.get(id), "ALL", null).items());
        views.addAll(admin.activities(1, 100, fixtureActivities.get(id), "ALL", adminId()).items());
        views.add(admin.roster(id, 1, 10, "ALL", adminId()).activity());
        views.addAll(registrations.mine(member).stream().map(RegistrationView::activity).toList());
        views.addAll(registrations.searchMine(member, 1, 10, "ALL").items().stream().map(item -> item.activity()).toList());
        views.addAll(favorites.page(member, 1, 10).items().stream().map(item -> item.activity()).toList());
        assertThat(views.stream().filter(item -> item.id() == id).toList()).hasSize(8).allSatisfy(item -> {
            assertThat(item.registrationDeadline()).isEqualTo(deadline); assertThat(item.registrationClosed()).isTrue(); assertThat(item.closed()).isFalse();
        });
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(adminId()))).with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("title", fixtureActivities.get(id), "description", "Owned end fixture", "location", "会场", "registrationDeadline", START.minusSeconds(1).toString()))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.registrationDeadline").value(deadline.toString())).andExpect(jsonPath("$.closed").value(false)).andExpect(jsonPath("$.registrationClosed").value(true));
    }

    @Test void deadlineFiltersAndSummaryExcludeClosedSignupButKeepUpcomingAndUseOneReadonlySnapshot() throws Exception {
        Instant deadline = NOW.plusSeconds(60); long expired = deadlineActivity(deadline, 3), fullExpired = deadlineActivity(deadline, 1);
        registrations.register(fullExpired, account()); long open = deadlineActivity(deadline.plusSeconds(1), 4), full = deadlineActivity(deadline.plusSeconds(1), 1);
        registrations.register(full, account()); long legacy = activity(END); clock.time.set(deadline);
        assertThat(activities.search(1, 100, prefix, "OPEN", null).items()).extracting(ActivityView::id).containsExactly(open, legacy);
        assertThat(activities.search(1, 100, prefix, "FULL", null).items()).extracting(ActivityView::id).containsExactly(full);
        var all = activities.search(2, 2, prefix, "ALL", null); assertThat(all.total()).isEqualTo(5);
        assertThat(all.summary()).isEqualTo(new ActivitySearchSummary(3, 6));
        assertThat(activities.search(1, 100, prefix, "UPCOMING", null).items()).extracting(ActivityView::id).containsExactly(expired, fullExpired, open, full, legacy);
        for (String filter : List.of("ALL", "OPEN", "FULL", "UPCOMING"))
            assertThat(admin.activities(1, 100, prefix, filter, adminId()).items()).isEqualTo(activities.search(1, 100, prefix, filter, adminId()).items());
        try (var writer = Executors.newSingleThreadExecutor()) {
            queries.afterTotals.set(() -> { try { writer.submit(() -> jdbc.update("UPDATE activities SET registration_deadline=? WHERE id=?", utc(deadline), open)).get(5, TimeUnit.SECONDS); }
                catch (Exception failure) { throw new AssertionError("Owned deadline change must commit between SELECTs", failure); } });
            List<SnapshotRead> reads = new ArrayList<>(); queries.captured.set(reads); clock.calls.set(0);
            var snapshot = activities.search(1, 100, prefix, "OPEN", null); queries.captured.remove();
            assertThat(snapshot.items()).extracting(ActivityView::id).containsExactly(open, legacy); assertThat(snapshot.summary()).isEqualTo(new ActivitySearchSummary(2, 6));
            assertThat(clock.calls.get()).isEqualTo(1); assertThat(reads).hasSize(2).allSatisfy(read -> {
                assertThat(read.now()).isEqualTo(utc(deadline)); assertThat(read.readOnly()).isTrue(); assertThat(read.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            });
        }
        assertThat(activities.search(1, 100, prefix, "OPEN", null).items()).extracting(ActivityView::id).containsExactly(legacy);
    }

    @Test void failedCreateAuditRollsBackDeadlineAlongWithActivity() {
        String title = prefix + " deadline rollback"; queries.failAudit.set(true);
        assertThatThrownBy(() -> activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, 2, "TECHNOLOGY", END, NOW.plusSeconds(60)), adminId()))
            .isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE title=?", Integer.class, title)).isZero();
    }

    private long deadlineActivity(Instant deadline, int capacity) {
        String title = prefix + " deadline " + fixtureActivities.size();
        long id = activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, capacity, "TECHNOLOGY", END, deadline), adminId()).id();
        fixtureActivities.put(id, title); return id;
    }
    private Map<String, Object> deadlineState(long id) {
        return Map.of("activity", jdbc.queryForMap("SELECT * FROM activities WHERE id=?", id),
            "registrations", jdbc.queryForList("SELECT * FROM registrations WHERE activity_id=? ORDER BY id", id),
            "notifications", jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id", id),
            "audit", jdbc.queryForList("SELECT * FROM activity_audit_logs WHERE activity_id=? ORDER BY id", id));
    }

    private void assertProjectionEnds(long id, long member, Instant end) throws Exception {
        assertThat(registrations.register(id, member).endsAt()).isEqualTo(end);
        assertThat(registrations.register(id, member).registeredCount()).isEqualTo(1);
        favoriteKeys.add(new FavoriteKey(member, id)); favorites.add(member, id);
        var detail = mvc.perform(get("/api/activities/" + id)).andExpect(status().isOk()).andReturn();
        assertJsonEnd(json.readTree(detail.getResponse().getContentAsString()), end);
        var oldList = json.readTree(mvc.perform(get("/api/activities")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
        boolean found = false;
        for (var item : oldList) if (item.get("id").asLong() == id) { assertJsonEnd(item, end); found = true; }
        assertThat(found).isTrue();
        var search = activities.search(1, 10, fixtureActivities.get(id), "ALL", null);
        assertThat(search.items()).singleElement().satisfies(item -> assertThat(item.endsAt()).isEqualTo(end));
        for (String path : List.of("/api/admin/activities",
            "/api/admin/activities/" + id + "/registrations", "/api/me/registrations", "/api/me/registrations/search", "/api/me/favorites")) {
            boolean admin = path.startsWith("/api/admin");
            var request = get(path).with(user(principal(admin ? adminId() : member)));
            if (path.equals("/api/admin/activities")) request.param("keyword", fixtureActivities.get(id));
            var result = mvc.perform(request).andExpect(status().isOk()).andReturn();
            if (path.equals("/api/admin/activities")) assertThat(result.getRequest().getParameter("keyword")).isEqualTo(fixtureActivities.get(id));
            var response = json.readTree(result.getResponse().getContentAsString());
            if (path.contains("/registrations") && admin) assertJsonEnd(response.get("activity"), end);
            else {
                var items = response.isArray() ? response : response.get("items");
                boolean projected = false;
                for (var item : items) {
                    var activity = item.has("activity") ? item.get("activity") : item;
                    if (activity.get("id").asLong() == id) { assertJsonEnd(activity, end); projected = true; }
                }
                assertThat(projected).as(path).isTrue();
            }
        }
        assertThat(registrations.cancel(id, member).endsAt()).isEqualTo(end);
    }
    private void assertJsonEnd(tools.jackson.databind.JsonNode item, Instant end) {
        assertThat(item.has("endsAt")).isTrue();
        if (end == null) assertThat(item.get("endsAt").isNull()).isTrue();
        else assertThat(item.get("endsAt").asText()).isEqualTo(end.toString());
    }
    private long postActivity(Map<String, Object> body) throws Exception {
        var response = mvc.perform(post("/api/admin/activities").with(user(principal(adminId()))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isCreated()).andReturn();
        long id = json.readTree(response.getResponse().getContentAsString()).get("id").asLong();
        fixtureActivities.put(id, (String) body.get("title")); return id;
    }
    private long activity(Instant end) {
        String title = prefix + " " + fixtureActivities.size();
        long id = activities.create(new CreateActivityRequest(title, "Owned end fixture", "会场", START, 2, "TECHNOLOGY", end), adminId()).id();
        fixtureActivities.put(id, title); return id;
    }
    private Map<String, Object> body(String title, String start) {
        var body = new LinkedHashMap<String, Object>(); body.put("title", title); body.put("description", "Owned end fixture");
        body.put("location", "北京时间会场"); body.put("startsAt", start); body.put("capacity", 2); return body;
    }
    private long account() {
        String username = "end_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "结束时间专项用户", "USER");
        long id = users.findByUsername(username).id(); fixtureUsers.put(id, username); return id;
    }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC); }
}

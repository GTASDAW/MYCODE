package com.example.gather;

import com.example.gather.api.ApiModels.*;
import com.example.gather.api.AuditLogModels.*;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.AuditLogMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AuditLogService;
import com.example.gather.service.CheckInService;
import com.example.gather.service.RegistrationService;
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
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.security.MessageDigest;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL transaction, FK, immutable snapshot, ordering and authorization evidence. */
@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc
@Import(AuditLogIntegrationTest.Configuration.class)
@ExtendWith(OutputCaptureExtension.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AuditLogIntegrationTest {
    private static final Instant NOW = Instant.parse("2038-06-01T09:00:00.123456Z");
    private static final String FIXTURE = "Audit integration fixture";
    private static final String INSERT = "com.example.gather.mapper.AuditLogMapper.insert";

    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary AuditClock auditClock() { return new AuditClock(); }
        @Bean AuditInterceptor auditInterceptor() { return new AuditInterceptor(); }
    }

    static class AuditClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return time.get(); }
    }

    record Hook(String statement, boolean before, Runnable action) {}
    @Intercepts({
        @Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})
    })
    static class AuditInterceptor implements Interceptor {
        final AtomicReference<Hook> hook = new AtomicReference<>();
        final AtomicBoolean failAppend = new AtomicBoolean();
        final AtomicLong allocatedActivity = new AtomicLong();
        final List<String> listStatements = new CopyOnWriteArrayList<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            MappedStatement statement = (MappedStatement) invocation.getArgs()[0];
            String id = statement.getId();
            if (id.equals(INSERT) && failAppend.getAndSet(false)) throw new DataAccessResourceFailureException("audit-failure-secret-must-not-be-logged");
            if (id.equals("com.example.gather.mapper.AuditLogMapper.page")) {
                listStatements.add(statement.getBoundSql(invocation.getArgs()[1]).getSql());
            }
            Hook next = hook.get();
            boolean hooked = next != null && id.equals(next.statement()) && hook.compareAndSet(next, null);
            if (hooked && next.before()) next.action().run();
            Object result = invocation.proceed();
            if (id.equals("com.example.gather.mapper.ActivityMapper.insert")) {
                allocatedActivity.set(((NewActivity) invocation.getArgs()[1]).id);
            }
            if (hooked && !next.before()) next.action().run();
            return result;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath())) {
            throw new IllegalStateException("Audit tests require dedicated REAL activity_platform_test MySQL");
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
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired AuditLogService audit;
    @Autowired AuditLogMapper auditMapper;
    @Autowired CheckInService checkIns;
    @Autowired RegistrationService registrations;
    @Autowired PlatformTransactionManager transactions;
    @Autowired AuditClock clock;
    @Autowired AuditInterceptor hooks;
    @Autowired ObjectMapper json;
    private final Set<Long> activityIds = new LinkedHashSet<>();
    private final Map<Long, String> ownedUsers = new LinkedHashMap<>();
    private long actor;

    @BeforeEach
    void prepareVerifiedFixtures() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", String.class)).isEqualTo("13");
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at, registration_deadline FROM activities LIMIT 0");
        actor = createUser("ADMIN", "审计管理员");
    }

    @AfterEach
    void deleteExactOwnedEventsBeforeBusinessRowsAndProtectExternalActorReferences() {
        hooks.hook.set(null);
        hooks.failAppend.set(false);
        clock.time.set(NOW);
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            for (var entry : ownedUsers.entrySet()) {
                long id = entry.getKey();
                assertThat(users.findById(id).username()).isEqualTo(entry.getValue());
                for (String query : List.of("SELECT activity_id FROM activity_audit_logs WHERE actor_user_id=?",
                    "SELECT activity_id FROM registrations WHERE checked_in_by=?", "SELECT activity_id FROM registrations WHERE user_id=?",
                    "SELECT activity_id FROM notifications WHERE user_id=?", "SELECT id FROM activities WHERE created_by=?", "SELECT id FROM activities WHERE cancelled_by=?")) {
                    assertThat(jdbc.queryForList(query, Long.class, id)).allMatch(activityIds::contains);
                }
            }
            for (long id : activityIds) {
                assertThat(jdbc.queryForList("SELECT activity_id FROM activity_audit_logs WHERE registration_id IN (SELECT id FROM registrations WHERE activity_id=?)", Long.class, id))
                    .allMatch(activityIds::contains);
            }
            for (long id : activityIds) jdbc.update("DELETE FROM activity_audit_logs WHERE activity_id=?", id);
            for (long id : activityIds) {
                jdbc.update("DELETE FROM notifications WHERE activity_id=?", id);
                jdbc.update("DELETE FROM registrations WHERE activity_id=?", id);
                jdbc.update("DELETE FROM activities WHERE id=?", id);
            }
            for (var entry : ownedUsers.entrySet()) jdbc.update("DELETE FROM users WHERE id=? AND username=?", entry.getKey(), entry.getValue());
        });
    }

    @Test
    void createStoresWhitelistedFullValuesAndTrustedCurrentIdentityRatherThanSessionOrClient(CapturedOutput output) throws Exception {
        var stalePrincipal = principal(actor);
        jdbc.update("UPDATE users SET display_name=? WHERE id=?", "数据库最新昵称", actor);
        String title = "  审计活动 " + UUID.randomUUID() + "  ";
        String description = "完整介绍\n<script>literal & \"text\"</script>";
        Instant start = NOW.plusSeconds(3600);
        var response = mvc.perform(post("/api/admin/activities").with(user(stalePrincipal)).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                "title", title, "description", " " + description + " ", "location", " 测试地点 ", "startsAt", start.toString(),
                "capacity", 3, "actorUserId", users.findByUsername("demo").id(), "password", "not-an-audit-field"))))
            .andReturn();
        long id = json.readTree(response.getResponse().getContentAsString()).get("id").asLong();
        activityIds.add(id);
        assertThat(response.getResponse().getStatus()).isEqualTo(201);
        var page = audit.search(1, 10, "ALL", id);
        assertThat(page.total()).isEqualTo(1);
        var detail = audit.detail(page.items().getFirst().id());
        assertThat(detail.action()).isEqualTo("CREATE");
        assertThat(detail.activityTitle()).isEqualTo(title.strip());
        assertThat(detail.actorUserId()).isEqualTo(actor);
        assertThat(detail.actorUsername()).isEqualTo(ownedUsers.get(actor));
        assertThat(detail.actorDisplayName()).isEqualTo("数据库最新昵称");
        assertThat(detail.registrationId()).isNull();
        assertThat(detail.targetUsername()).isNull();
        assertThat(detail.targetDisplayName()).isNull();
        assertThat(detail.occurredAt()).isEqualTo(NOW);
        assertThat(detail.changes()).containsExactly(new AuditChange("title", null, title.strip()),
            new AuditChange("description", null, description), new AuditChange("location", null, "测试地点"),
            new AuditChange("startsAt", null, start.toString()), new AuditChange("endsAt", null, null),
            new AuditChange("registrationDeadline", null, null),
            new AuditChange("capacity", null, "3"),
            new AuditChange("category", null, "UNCATEGORIZED"));
        assertThat(jdbc.queryForObject("SELECT changes_json FROM activity_audit_logs WHERE id=?", String.class, detail.id()))
            .doesNotContain("password", "not-an-audit-field", "actorUserId");
        assertThat(output.getAll()).doesNotContain(description, "not-an-audit-field", title.strip());
    }

    @Test
    void nanosecondStartInputUsesExactlyThePersistedMicrosecondValueInCreateAudit() throws Exception {
        Instant submitted = NOW.plusSeconds(3600).plusNanos(987);
        Instant persisted = submitted.truncatedTo(java.time.temporal.ChronoUnit.MICROS);
        var response = mvc.perform(post("/api/admin/activities").with(user(principal(actor))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                "title", "纳秒输入审计 " + UUID.randomUUID(), "description", FIXTURE, "location", "测试地点",
                "startsAt", submitted.toString(), "capacity", 1)))).andReturn();
        var body = json.readTree(response.getResponse().getContentAsString());
        long id = body.get("id").asLong();
        activityIds.add(id);
        assertThat(response.getResponse().getStatus()).isEqualTo(201);
        assertThat(submitted.toString()).contains("123456987Z");
        assertThat(Instant.parse(body.get("startsAt").asString())).isEqualTo(persisted);
        assertThat(activities.get(id, actor).startsAt()).isEqualTo(persisted);
        assertThat(jdbc.queryForObject("SELECT starts_at FROM activities WHERE id=?", LocalDateTime.class, id))
            .isEqualTo(LocalDateTime.ofInstant(persisted, ZoneOffset.UTC));
        var detail = audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id());
        assertThat(detail.changes()).contains(new AuditChange("startsAt", null, persisted.toString()));
    }

    @Test
    void createRequiresPersistedStartToRemainFutureAtTheMicrosecondBoundary() throws Exception {
        String title = "微秒边界审计 " + UUID.randomUUID();
        mvc.perform(post("/api/admin/activities").with(user(principal(actor))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                    "title", title, "description", FIXTURE, "location", "测试地点",
                    "startsAt", NOW.plusNanos(1).toString(), "capacity", 1))))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE created_by=?", Integer.class, actor)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE actor_user_id=?", Integer.class, actor)).isZero();

        Instant firstFutureMicrosecond = NOW.plusNanos(1000);
        var response = mvc.perform(post("/api/admin/activities").with(user(principal(actor))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of(
                "title", title, "description", FIXTURE, "location", "测试地点",
                "startsAt", firstFutureMicrosecond.toString(), "capacity", 1)))).andReturn();
        long id = json.readTree(response.getResponse().getContentAsString()).get("id").asLong();
        activityIds.add(id);
        assertThat(response.getResponse().getStatus()).isEqualTo(201);
        assertThat(activities.get(id, actor).startsAt()).isEqualTo(firstFutureMicrosecond);
        assertThat(jdbc.queryForObject("SELECT starts_at FROM activities WHERE id=?", LocalDateTime.class, id))
            .isEqualTo(LocalDateTime.ofInstant(firstFutureMicrosecond, ZoneOffset.UTC));
        var detail = audit.detail(audit.search(1, 10, "CREATE", id).items().getFirst().id());
        assertThat(detail.changes()).contains(new AuditChange("startsAt", null, firstFutureMicrosecond.toString()));
    }

    @Test
    void editsUseExactJavaComparisonPreserveLongTextAndNoopDoesNotAppend() throws Exception {
        long id = activity(2);
        String original = activities.get(id, actor).title();
        String longText = "介绍\n\"<script>只作为文字</script>\"" + "长".repeat(9900);
        var changed = activities.edit(id, new EditActivityRequest(original.toUpperCase(Locale.ROOT), longText, "新地点"), actor);
        var edits = audit.search(1, 10, "EDIT", id);
        assertThat(edits.total()).isEqualTo(1);
        var detail = audit.detail(edits.items().getFirst().id());
        assertThat(detail.changes()).containsExactly(new AuditChange("title", original, original.toUpperCase(Locale.ROOT)),
            new AuditChange("description", FIXTURE, longText), new AuditChange("location", "测试地点", "新地点"));
        runTogether(4, () -> activities.edit(id, new EditActivityRequest(" " + changed.title() + " ", " " + longText + " ", " 新地点 "), actor));
        assertThat(audit.search(1, 10, "EDIT", id).total()).isEqualTo(1);
        jdbc.update("UPDATE users SET display_name='后来昵称' WHERE id=?", actor);
        activities.edit(id, new EditActivityRequest("另一个标题", longText, "新地点"), actor);
        assertThat(audit.detail(detail.id())).isEqualTo(detail);
        assertThat(audit.search(1, 10, "EDIT", id).items().getFirst().actorDisplayName()).isEqualTo("后来昵称");
    }

    @Test
    void cancellationAuditSharesFirstTimeAndPreservesIdempotentNotificationsAndCounts() throws Exception {
        long id = activity(1);
        long active = createUser("USER", "有效用户");
        long waiting = createUser("USER", "候补用户");
        registrations.register(id, active);
        registrations.register(id, waiting);
        runTogether(4, () -> activities.cancel(id, new CancelActivityRequest(" 场地不可用 "), actor));
        var events = audit.search(1, 10, "CANCEL", id);
        assertThat(events.total()).isEqualTo(1);
        var detail = audit.detail(events.items().getFirst().id());
        assertThat(detail.occurredAt()).isEqualTo(NOW);
        assertThat(detail.changes()).containsExactly(new AuditChange("cancelledAt", null, NOW.toString()),
            new AuditChange("cancellationReason", null, "场地不可用"));
        assertThat(activities.get(id, actor).registeredCount()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isEqualTo(2);
        assertThat(jdbc.queryForList("SELECT status FROM registrations WHERE activity_id=?", String.class, id)).containsOnly("CANCELLED");
        clock.time.set(NOW.plusSeconds(7200));
        activities.cancel(id, new CancelActivityRequest("后来原因"), actor);
        assertThat(audit.detail(detail.id())).isEqualTo(detail);
        assertThat(activities.get(id, actor).cancellationReason()).isEqualTo("场地不可用");
    }

    @Test
    void checkInAuditCopiesTargetAndFirstActorWithoutChangingRegistrationOrQueue() throws Exception {
        long id = activity(1);
        long target = createUser("USER", "签到用户最新昵称");
        registrations.register(id, target);
        long registrationId = registration(id, target);
        LocalDateTime updated = jdbc.queryForObject("SELECT updated_at FROM registrations WHERE id=?", LocalDateTime.class, registrationId);
        initializeStartedFixture(id);
        var stalePrincipal = principal(actor);
        jdbc.update("UPDATE users SET display_name='签到管理员最新昵称' WHERE id=?", actor);
        mvc.perform(post("/api/admin/activities/" + id + "/registrations/" + registrationId + "/check-in")
                .with(user(stalePrincipal)).with(csrf()).param("adminId", Long.toString(target))
                .contentType(MediaType.APPLICATION_JSON).content("{\"actorUserId\":" + target + "}"))
            .andExpect(status().isOk());
        long otherActor = createUser("ADMIN", "重复请求管理员");
        runTogether(4, () -> checkIns.checkIn(id, registrationId, otherActor));
        var events = audit.search(1, 10, "CHECK_IN", id);
        assertThat(events.total()).isEqualTo(1);
        var detail = audit.detail(events.items().getFirst().id());
        assertThat(detail.actorUserId()).isEqualTo(actor);
        assertThat(detail.actorDisplayName()).isEqualTo("签到管理员最新昵称");
        assertThat(detail.registrationId()).isEqualTo(registrationId);
        assertThat(detail.targetUsername()).isEqualTo(ownedUsers.get(target));
        assertThat(detail.targetDisplayName()).isEqualTo("签到用户最新昵称");
        assertThat(detail.occurredAt()).isEqualTo(NOW);
        assertThat(detail.changes()).containsExactly(new AuditChange("checkedInAt", null, NOW.toString()));
        assertThat(jdbc.queryForObject("SELECT checked_in_at FROM registrations WHERE id=?", LocalDateTime.class, registrationId))
            .isEqualTo(LocalDateTime.ofInstant(NOW, ZoneOffset.UTC));
        assertThat(jdbc.queryForObject("SELECT updated_at FROM registrations WHERE id=?", LocalDateTime.class, registrationId)).isEqualTo(updated);
        assertThat(activities.get(id, actor).registeredCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        jdbc.update("UPDATE users SET display_name='后来参与者昵称' WHERE id=?", target);
        assertThat(audit.detail(detail.id())).isEqualTo(detail);
    }

    @Test
    void crossActivityAndIneligibleCheckInNeverAppend() throws Exception {
        long id = activity(1);
        long other = activity(1);
        long target = createUser("USER", "参与者");
        registrations.register(other, target);
        initializeStartedFixture(id);
        mvc.perform(post("/api/admin/activities/" + id + "/registrations/" + registration(other, target) + "/check-in")
                .with(user(principal(actor))).with(csrf())).andExpect(status().isNotFound());
        assertThat(audit.search(1, 10, "CHECK_IN", id).total()).isZero();
        assertThat(audit.search(1, 10, "CHECK_IN", other).total()).isZero();
    }

    @Test
    void notStartedWaitingAndCancelledRegistrationsNeverProduceAttendanceEvents() {
        long id = activity(1);
        long first = createUser("USER", "有效参与者");
        long second = createUser("USER", "候补参与者");
        registrations.register(id, first);
        registrations.register(id, second);
        long activeId = registration(id, first);
        long waitingId = registration(id, second);
        assertThatThrownBy(() -> checkIns.checkIn(id, activeId, actor)).hasMessageContaining("活动开始后");
        initializeStartedFixture(id);
        assertThatThrownBy(() -> checkIns.checkIn(id, waitingId, actor)).hasMessageContaining("只有有效报名者");
        assertThat(audit.search(1, 10, "CHECK_IN", id).total()).isZero();
        long cancelled = activity(1);
        registrations.register(cancelled, first);
        activities.cancel(cancelled, new CancelActivityRequest("活动取消"), actor);
        initializeStartedFixture(cancelled);
        assertThatThrownBy(() -> checkIns.checkIn(cancelled, registration(cancelled, first), actor)).hasMessageContaining("活动已取消");
        assertThat(audit.search(1, 10, "CHECK_IN", cancelled).total()).isZero();
    }

    @Test
    void failedAuditInsertRollsBackCreateAndEditWithoutHalfCompletedBusiness(CapturedOutput output) throws Exception {
        hooks.failAppend.set(true);
        assertThatThrownBy(() -> activity(2)).isInstanceOf(DataAccessException.class);
        long failedId = hooks.allocatedActivity.get();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id=?", Integer.class, failedId)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_id=?", Integer.class, failedId)).isZero();
        long id = activity(2);
        var before = activities.get(id, actor);
        hooks.failAppend.set(true);
        mvc.perform(patch("/api/admin/activities/" + id).with(user(principal(actor))).with(csrf())
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("title", "失败标题", "description", "失败介绍", "location", "失败地点"))))
            .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("INTERNAL_ERROR"));
        assertThat(activities.get(id, actor)).isEqualTo(before);
        assertThat(audit.search(1, 10, "ALL", id).total()).isEqualTo(1);
        assertThat(output.getAll()).doesNotContain("audit-failure-secret-must-not-be-logged", "失败介绍");
    }

    @Test
    void failedCancellationAuditRollsBackNotificationAndRegistrationAndActivityChanges() {
        long id = activity(1);
        long first = createUser("USER", "有效者");
        long second = createUser("USER", "候补者");
        registrations.register(id, first);
        registrations.register(id, second);
        var before = jdbc.queryForList("SELECT id, status, updated_at FROM registrations WHERE activity_id=? ORDER BY id", id);
        hooks.failAppend.set(true);
        assertThatThrownBy(() -> activities.cancel(id, new CancelActivityRequest("取消失败"), actor)).isInstanceOf(DataAccessException.class);
        assertThat(activities.get(id, actor).cancelled()).isFalse();
        assertThat(activities.get(id, actor).registeredCount()).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT id, status, updated_at FROM registrations WHERE activity_id=? ORDER BY id", id)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        assertThat(audit.search(1, 10, "ALL", id).total()).isEqualTo(1);
    }

    @Test
    void failedCheckInAuditRollsBackBothAttendanceColumnsAndHasNoOtherEffects() {
        long id = activity(1);
        long target = createUser("USER", "到场参与者");
        registrations.register(id, target);
        long registrationId = registration(id, target);
        initializeStartedFixture(id);
        var before = jdbc.queryForMap("SELECT * FROM registrations WHERE id=?", registrationId);
        hooks.failAppend.set(true);
        assertThatThrownBy(() -> checkIns.checkIn(id, registrationId, actor)).isInstanceOf(DataAccessException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM registrations WHERE id=?", registrationId)).isEqualTo(before);
        assertThat(activities.get(id, actor).registeredCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Integer.class, id)).isZero();
        assertThat(audit.search(1, 10, "CHECK_IN", id).total()).isZero();
    }

    @Test
    void queryRequiresAdminValidatesFiltersAndReturnsStablePagesWithoutLongChanges() throws Exception {
        long id = activity(2);
        activities.edit(id, new EditActivityRequest("编辑一", FIXTURE, "测试地点"), actor);
        activities.edit(id, new EditActivityRequest("编辑二", FIXTURE, "测试地点"), actor);
        long auditId = audit.search(1, 10, "ALL", id).items().getFirst().id();
        for (String path : List.of("/api/admin/audit-logs", "/api/admin/audit-logs/" + auditId)) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
            mvc.perform(get(path).with(user(principal(users.findByUsername("demo").id())))).andExpect(status().isForbidden());
            mvc.perform(get(path).with(user(principal(actor)))).andExpect(status().isOk());
        }
        for (var query : List.of(Map.of("page", "0"), Map.of("pageSize", "101"), Map.of("pageSize", "0"),
                Map.of("page", "abc"), Map.of("action", "UNKNOWN"), Map.of("activityId", "0"), Map.of("activityId", "-1"), Map.of("activityId", "abc"))) {
            var request = get("/api/admin/audit-logs").with(user(principal(actor)));
            query.forEach(request::param);
            mvc.perform(request).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        }
        var first = audit.search(1, 2, "ALL", id);
        var second = audit.search(2, 2, "ALL", id);
        assertThat(first.total()).isEqualTo(3);
        assertThat(first.items()).hasSize(2);
        assertThat(second.items()).hasSize(1);
        List<Long> ids = new ArrayList<>();
        first.items().forEach(row -> ids.add(row.id())); second.items().forEach(row -> ids.add(row.id()));
        assertThat(ids).isSortedAccordingTo(Comparator.reverseOrder()).doesNotHaveDuplicates();
        assertThat(audit.search(1, 10, "EDIT", id).total()).isEqualTo(2);
        assertThat(audit.search(99, 10, "ALL", id).items()).isEmpty();
        assertThat(audit.search(99, 10, "ALL", id).total()).isEqualTo(3);
        assertThat(audit.search(1, 10, "ALL", Long.MAX_VALUE).items()).isEmpty();
        mvc.perform(get("/api/admin/audit-logs").param("activityId", Long.toString(id)).with(user(principal(actor))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].changes").doesNotExist())
            .andExpect(jsonPath("$.items[0].changesJson").doesNotExist());
        mvc.perform(get("/api/admin/audit-logs/" + Long.MAX_VALUE).with(user(principal(actor))))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("AUDIT_LOG_NOT_FOUND"));
        assertThat(hooks.listStatements).isNotEmpty().allSatisfy(sql -> assertThat(sql.toLowerCase(Locale.ROOT)).doesNotContain("changes_json"));
        for (var request : List.of(post("/api/admin/audit-logs"), patch("/api/admin/audit-logs/" + auditId), delete("/api/admin/audit-logs/" + auditId))) {
            mvc.perform(request.with(user(principal(actor))).with(csrf())).andExpect(status().isMethodNotAllowed());
        }
        clock.time.set(NOW.minusSeconds(60));
        activities.edit(id, new EditActivityRequest("更晚的 ID、更早的时刻", FIXTURE, "测试地点"), actor);
        var ordered = audit.search(1, 10, "ALL", id).items();
        assertThat(ordered.getFirst().id()).isEqualTo(auditId);
        assertThat(ordered.getLast().occurredAt()).isEqualTo(NOW.minusSeconds(60));
    }

    @Test
    void countAndPageShareSnapshotWhileAnotherTransactionAppends() throws Exception {
        long id = activity(2);
        try (var worker = Executors.newSingleThreadExecutor()) {
            hooks.hook.set(new Hook("com.example.gather.mapper.AuditLogMapper.count", false, () -> {
                try { worker.submit(() -> activities.edit(id, new EditActivityRequest("并发修改", FIXTURE, "测试地点"), actor)).get(10, TimeUnit.SECONDS); }
                catch (Exception failure) { throw new IllegalStateException("Concurrent fixture edit failed", failure); }
            }));
            var snapshot = audit.search(1, 10, "ALL", id);
            assertThat(snapshot.total()).isEqualTo(1);
            assertThat(snapshot.items()).hasSize(1).allSatisfy(row -> assertThat(row.action()).isEqualTo("CREATE"));
            assertThat(audit.search(1, 10, "ALL", id).total()).isEqualTo(2);
        }
    }

    @Test
    void auditForeignKeysRestrictBusinessDeletionAndMandatoryAppendCannotRunAlone() {
        long id = activity(1);
        long target = createUser("USER", "引用参与者");
        registrations.register(id, target);
        initializeStartedFixture(id);
        long registrationId = registration(id, target);
        checkIns.checkIn(id, registrationId, actor);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM activities WHERE id=?", id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM users WHERE id=?", actor)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("DELETE FROM registrations WHERE id=?", registrationId)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> audit.checkedIn(id, actor, registrationId, LocalDateTime.ofInstant(NOW, ZoneOffset.UTC)))
            .isInstanceOf(IllegalTransactionStateException.class);
    }

    @Test
    void ownedCleanupRejectsExternalAuditActorBeforeDeletingAnyOwnedRows() throws Exception {
        long ownedActivity = activity(1);
        long externalCreator = createUser("ADMIN", "外部活动创建者");
        long externalActivity = activities.create(new CreateActivityRequest("external audit " + UUID.randomUUID(), FIXTURE,
            "测试地点", NOW.plusSeconds(3600), 1), externalCreator).id();
        activityIds.add(externalActivity);
        activities.edit(externalActivity, new EditActivityRequest("外部活动由本轮管理员修改", FIXTURE, "测试地点"), actor);
        Map<String, String> before = databaseSnapshotDigests();

        assertThatThrownBy(() -> OwnedIntegrationFixtures.remove(jdbc, List.of(ownedActivity), List.of(actor)))
            .isInstanceOf(IllegalStateException.class).hasMessageContaining("actor in an external audit");

        assertThat(databaseSnapshotDigests()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id=?", Integer.class, ownedActivity)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM users WHERE id=?", Integer.class, actor)).isEqualTo(1);
    }

    @Test
    void ownedCleanupRejectsExternalAuditPointingAtOwnedRegistrationAndRecoversAfterExactRepair() throws Exception {
        long ownedActivity = activity(1);
        long externalActivity = activity(1);
        long target = createUser("USER", "跨活动引用保护样例");
        registrations.register(ownedActivity, target);
        long ownedRegistration = registration(ownedActivity, target);
        long malformedAudit = insertCrossActivityAuditFixture(externalActivity, ownedRegistration, target);
        try {
            Map<String, String> before = databaseSnapshotDigests();
            assertThatThrownBy(() -> OwnedIntegrationFixtures.remove(jdbc, List.of(ownedActivity), List.of()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("external audit references an owned registration");
            assertThat(databaseSnapshotDigests()).isEqualTo(before);
        } finally {
            // Remove only the exact deliberately malformed event, even if the refusal assertion fails.
            assertThat(jdbc.update("DELETE FROM activity_audit_logs WHERE id=? AND activity_id=? AND registration_id=?",
                malformedAudit, externalActivity, ownedRegistration)).isEqualTo(1);
        }

        OwnedIntegrationFixtures.remove(jdbc, List.of(ownedActivity), List.of());
        activityIds.remove(ownedActivity);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id=?", Integer.class, ownedActivity)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE id=?", Integer.class, ownedRegistration)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs WHERE activity_id=?", Integer.class, ownedActivity)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id=?", Integer.class, externalActivity)).isEqualTo(1);
        assertThat(audit.search(1, 10, "ALL", externalActivity).total()).isEqualTo(1);
    }

    private Map<String, String> databaseSnapshotDigests() throws Exception {
        Map<String, String> snapshots = new LinkedHashMap<>();
        for (String table : List.of("activity_favorites", "activity_audit_logs", "notifications", "registrations", "activities", "users")) {
            byte[] rows = json.writeValueAsBytes(jdbc.queryForList("SELECT * FROM " + table + " ORDER BY id"));
            snapshots.put(table, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(rows)));
        }
        return snapshots;
    }

    private long insertCrossActivityAuditFixture(long activityId, long registrationId, long targetId) {
        var actorRow = users.findById(actor);
        var targetRow = users.findById(targetId);
        String activityTitle = activities.get(activityId, actor).title();
        var keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement("""
                INSERT INTO activity_audit_logs(action, activity_id, activity_title, actor_user_id, actor_username,
                    actor_display_name, registration_id, target_username, target_display_name, occurred_at, changes_json)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, Statement.RETURN_GENERATED_KEYS);
            statement.setString(1, "CHECK_IN");
            statement.setLong(2, activityId);
            statement.setString(3, activityTitle);
            statement.setLong(4, actor);
            statement.setString(5, actorRow.username());
            statement.setString(6, actorRow.displayName());
            statement.setLong(7, registrationId);
            statement.setString(8, targetRow.username());
            statement.setString(9, targetRow.displayName());
            statement.setTimestamp(10, Timestamp.valueOf(LocalDateTime.ofInstant(NOW, ZoneOffset.UTC)));
            statement.setString(11, json.writeValueAsString(List.of(new AuditChange("checkedInAt", null, NOW.toString()))));
            return statement;
        }, keys);
        return Objects.requireNonNull(keys.getKey()).longValue();
    }

    private long createUser(String role, String name) {
        String username = "audit_" + UUID.randomUUID().toString().replace("-", "");
        assertThat(users.findByUsername(username)).isNull();
        users.insert(username, users.findByUsername("demo").passwordHash(), name, role);
        long id = users.findByUsername(username).id();
        ownedUsers.put(id, username);
        return id;
    }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private long activity(int capacity) {
        long id = activities.create(new CreateActivityRequest("audit " + UUID.randomUUID(), FIXTURE,
            "测试地点", NOW.plusSeconds(3600), capacity), actor).id();
        activityIds.add(id);
        return id;
    }
    private long registration(long activityId, long userId) {
        return jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activityId, userId);
    }
    private void initializeStartedFixture(long id) {
        // Only this test's newly created fixture is initialized; published demo activities are untouched.
        assertThat(activityIds).contains(id);
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", LocalDateTime.ofInstant(NOW, ZoneOffset.UTC), id);
    }
    private static void runTogether(int count, Runnable action) throws Exception {
        var start = new CountDownLatch(1);
        List<Future<?>> results = new ArrayList<>();
        try (var workers = Executors.newFixedThreadPool(count)) {
            for (int index = 0; index < count; index++) results.add(workers.submit(() -> {
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Audit barrier timed out");
                action.run();
                return null;
            }));
            start.countDown();
            for (var result : results) result.get(20, TimeUnit.SECONDS);
        }
    }
}

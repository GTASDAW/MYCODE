package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
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
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.*;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.ObjectMapper;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL persistence, lock serialization, audit rollback and real servlet upload limits. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(ActivityCoverIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ActivityCoverIntegrationTest {
    static final Instant NOW = Instant.parse("2045-10-01T09:00:00.123456Z");
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary Clock coverClock() { return Clock.fixed(NOW, ZoneOffset.UTC); }
        @Bean CoverQueries coverQueries() { return new CoverQueries(); }
        @Bean @Primary ImageProbe imageProbe() { return new ImageProbe(); }
    }
    static class ImageProbe extends ActivityCoverImages {
        final AtomicBoolean preparedInTransaction = new AtomicBoolean();
        @Override public Prepared prepare(MultipartFile file) {
            preparedInTransaction.set(TransactionSynchronizationManager.isActualTransactionActive());
            return super.prepare(file);
        }
    }
    record Query(String sql, Integer isolation) {}
    @Intercepts({@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})})
    static class CoverQueries implements Interceptor {
        final AtomicBoolean failAudit = new AtomicBoolean();
        final AtomicReference<Runnable> afterLock = new AtomicReference<>();
        final List<Query> locks = new CopyOnWriteArrayList<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (statement.getId().endsWith("AuditLogMapper.insert") && failAudit.getAndSet(false)) throw new DataAccessResourceFailureException("Injected cover audit failure");
            Object result = invocation.proceed();
            if (statement.getId().endsWith("ActivityMapper.lockById")) {
                locks.add(new Query(statement.getBoundSql(invocation.getArgs()[1]).getSql(), TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
                var hook = afterLock.getAndSet(null); if (hook != null) hook.run();
            }
            return result;
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Cover tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"), "activity"));
        properties.add("spring.datasource.password", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"), "activity_dev_password"));
        properties.add("app.demo-seed-enabled", () -> "true");
        properties.add("app.demo-admin-password", () -> "Admin123!"); properties.add("app.demo-user-password", () -> "Demo123!");
    }
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ActivityMapper mapper;
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired ActivityCoverService covers;
    @Autowired ImageProbe images;
    @Autowired RegistrationService registrations;
    @Autowired FavoriteService favorites;
    @Autowired AuditLogService audit;
    @Autowired AdminService admin;
    @Autowired CoverQueries queries;
    @Autowired ObjectMapper json;
    @Autowired PasswordEncoder passwords;
    @LocalServerPort int port;
    final Map<Long, String> fixtureActivities = new LinkedHashMap<>();
    final Map<Long, String> fixtureUsers = new LinkedHashMap<>();
    final List<FavoriteKey> favoriteKeys = new ArrayList<>();
    final String prefix = "Cover " + UUID.randomUUID();

    @BeforeEach void gate() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(12);
        jdbc.queryForList("SELECT id,category,cover_hash,cover_image,ends_at,registration_deadline FROM activities LIMIT 0");
    }
    @AfterEach void cleanup() {
        queries.failAudit.set(false); queries.afterLock.set(null); queries.locks.clear();
        fixtureActivities.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        fixtureUsers.forEach((id, username) -> assertThat(users.findById(id).username()).isEqualTo(username));
        OwnedIntegrationFixtures.remove(jdbc, fixtureActivities.keySet(), fixtureUsers.keySet(), favoriteKeys);
    }
    long adminId() { return users.findByUsername("admin").id(); }
    AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    long activity() {
        var row = new NewActivity(prefix + " " + fixtureActivities.size(), "Owned cover fixture", "本地会场",
            LocalDateTime.ofInstant(NOW.plusSeconds(3600), ZoneOffset.UTC), 2, adminId(), "TECHNOLOGY");
        mapper.insert(row); fixtureActivities.put(row.id, row.title); return row.id;
    }
    long account(String role) {
        String username = "cover_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, passwords.encode("CoverLocal123!"), "封面专项账号", role);
        long id = users.findByUsername(username).id(); fixtureUsers.put(id, username); return id;
    }
    static MockMultipartFile png() throws Exception {
        var image = new BufferedImage(24, 12, BufferedImage.TYPE_INT_ARGB);
        var output = new ByteArrayOutputStream(); ImageIO.write(image, "PNG", output);
        return new MockMultipartFile("file", "封面.png", "image/png", output.toByteArray());
    }
    String path(long id) { return "/api/admin/activities/" + id + "/cover"; }
    String imagePath(long id) { return "/api/activities/" + id + "/cover"; }
    ActivityView putCover(long id) throws Exception {
        String response = mvc.perform(multipart(path(id)).file(png()).with(user(principal(adminId()))).with(csrf()))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return json.readValue(response, ActivityView.class);
    }
    long edits(long id) { return audit.search(1, 100, "EDIT", id).total(); }

    @Test void authorizationCsrfAndPublicReadNeverTrustRequestIdentity() throws Exception {
        long id = activity(), member = account("USER");
        mvc.perform(get(imagePath(id))).andExpect(status().isNotFound());
        mvc.perform(multipart(path(id)).file(png()).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(multipart(path(id)).file(png()).with(user(principal(member))).with(csrf())).andExpect(status().isForbidden());
        mvc.perform(multipart(path(id)).file(png()).with(user(principal(adminId())))).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(delete(path(id)).with(user(principal(member))).with(csrf())).andExpect(status().isForbidden());
        mvc.perform(delete(path(id)).with(user(principal(adminId())))).andExpect(status().isForbidden());
        assertThat(edits(id)).isZero();
        putCover(id);
        mvc.perform(get(imagePath(id))).andExpect(status().isOk()).andExpect(content().contentType("image/jpeg"));
        var old = principal(member); jdbc.update("UPDATE users SET credential_version=credential_version+1 WHERE id=?", member);
        mvc.perform(get(imagePath(id)).with(user(old))).andExpect(status().isOk());
        mvc.perform(get("/api/auth/me").with(user(old))).andExpect(status().isUnauthorized());
    }

    @Test void normalizesBeforeLockReturnsSafeJpegHeadersAndRevalidatesChangedOrRemovedImage() throws Exception {
        long id = activity();
        assertThat(activities.get(id, null).coverUrl()).isNull();
        var view = putCover(id);
        assertThat(images.preparedInTransaction).isFalse();
        String hash = jdbc.queryForObject("SELECT cover_hash FROM activities WHERE id=?", String.class, id);
        assertThat(view.coverUrl()).isEqualTo(imagePath(id) + "?v=" + hash);
        var response = mvc.perform(get(view.coverUrl())).andExpect(status().isOk()).andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andExpect(header().string("Cache-Control", "no-cache")).andExpect(header().string("ETag", '"' + hash + '"'))
            .andReturn().getResponse();
        assertThat(response.getContentAsByteArray()).isEqualTo(covers.get(id).coverImage());
        mvc.perform(get(view.coverUrl()).header("If-None-Match", response.getHeader("ETag"))).andExpect(status().isNotModified());
        assertThat(queries.locks).isNotEmpty().allSatisfy(lock -> {
            assertThat(lock.sql()).isEqualTo("SELECT starts_at, capacity, registered_count, cancelled_at FROM activities WHERE id=? FOR UPDATE");
            assertThat(lock.isolation()).isEqualTo(TransactionDefinition.ISOLATION_READ_COMMITTED);
        });
        mvc.perform(delete(path(id)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk()).andExpect(jsonPath("$.coverUrl").isEmpty());
        mvc.perform(get(view.coverUrl()).header("If-None-Match", response.getHeader("ETag"))).andExpect(status().isNotFound());
    }

    @Test void allLegacyPagedAndJoinedActivityViewsExposeTheSameUrlWithoutLoadingBlob() throws Exception {
        long id = activity(), member = account("USER");
        registrations.register(id, member);
        favoriteKeys.add(new FavoriteKey(member, id)); favorites.add(member, id);
        var before = jdbc.queryForMap("SELECT registered_count,starts_at,capacity,category FROM activities WHERE id=?", id);
        var registration = jdbc.queryForMap("SELECT * FROM registrations WHERE activity_id=? AND user_id=?", id, member);
        long notices = jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Long.class, id);
        var view = putCover(id); String url = view.coverUrl();
        assertThat(activities.list(member).stream().filter(item -> item.id() == id).findFirst().orElseThrow().coverUrl()).isEqualTo(url);
        assertThat(activities.search(1, 100, prefix, "ALL", member).items()).singleElement().extracting(ActivityView::coverUrl).isEqualTo(url);
        assertThat(admin.activities(1, 100, prefix, "ALL", adminId()).items()).singleElement().extracting(ActivityView::coverUrl).isEqualTo(url);
        assertThat(admin.roster(id, 1, 10, "ALL", adminId()).activity().coverUrl()).isEqualTo(url);
        assertThat(registrations.mine(member)).singleElement().extracting(item -> item.activity().coverUrl()).isEqualTo(url);
        assertThat(registrations.searchMine(member, 1, 10, "ALL").items()).singleElement().extracting(item -> item.activity().coverUrl()).isEqualTo(url);
        assertThat(favorites.page(member, 1, 10).items()).singleElement().extracting(item -> item.activity().coverUrl()).isEqualTo(url);
        assertThat(com.example.gather.mapper.ActivityMapper.VIEW_COLUMNS).contains("a.cover_hash").doesNotContain("cover_image");
        assertThat(com.example.gather.mapper.RegistrationMapper.MY_VIEW_COLUMNS).contains("a.cover_hash").doesNotContain("cover_image");
        assertThat(jdbc.queryForMap("SELECT registered_count,starts_at,capacity,category FROM activities WHERE id=?", id)).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT * FROM registrations WHERE activity_id=? AND user_id=?", id, member)).isEqualTo(registration);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?", Long.class, id)).isEqualTo(notices);
        assertThat(registrations.register(id, member).coverUrl()).isEqualTo(url);
        assertThat(registrations.cancel(id, member).coverUrl()).isEqualTo(url);
    }

    @Test void duplicateUploadAndRemovePreserveFirstAuditAndRecordOnlyHashValues() throws Exception {
        long id = activity(); var first = putCover(id); putCover(id);
        assertThat(edits(id)).isEqualTo(1);
        var change = audit.detail(audit.search(1, 10, "EDIT", id).items().getFirst().id()).changes();
        assertThat(change).singleElement().satisfies(item -> {
            assertThat(item.field()).isEqualTo("coverHash"); assertThat(item.before()).isNull(); assertThat(item.after()).matches("[0-9a-f]{64}");
        });
        mvc.perform(delete(path(id)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk());
        mvc.perform(delete(path(id)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk());
        assertThat(edits(id)).isEqualTo(2);
        String stored = jdbc.queryForObject("SELECT GROUP_CONCAT(changes_json) FROM activity_audit_logs WHERE activity_id=?", String.class, id);
        assertThat(stored).contains("coverHash").doesNotContain("封面.png", "image/png", "base64");
        assertThat(first.coverUrl()).isNotNull();
    }

    @Test void invalidOrOversizedUploadsNeverWriteOrAppendAnAudit() throws Exception {
        long id = activity();
        for (var invalid : List.of(new MockMultipartFile("file", "x.svg", "image/svg+xml", "<svg/>".getBytes()),
            new MockMultipartFile("file", "x.jpg", "image/jpeg", png().getBytes()),
            new MockMultipartFile("file", "x.png", "image/png", new byte[0]))) {
            mvc.perform(multipart(path(id)).file(invalid).with(user(principal(adminId()))).with(csrf()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_COVER"));
        }
        mvc.perform(multipart(path(id)).file(new MockMultipartFile("file", "x.png", "image/png", new byte[ActivityCoverImages.MAX_BYTES + 1]))
            .with(user(principal(adminId()))).with(csrf())).andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.code").value("UPLOAD_TOO_LARGE"));
        mvc.perform(multipart(path(id)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isBadRequest());
        mvc.perform(post(path(id)).with(user(principal(adminId()))).with(csrf())
            .contentType("application/json").content("{}"))
            .andExpect(status().isUnsupportedMediaType()).andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));
        assertThat(edits(id)).isZero(); assertThat(activities.get(id, null).coverUrl()).isNull();
    }

    @Test void checksLockedLifecycleForUploadsAndDeletesAndKeepsCancelledCoverReadable() throws Exception {
        long started = activity();
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", LocalDateTime.ofInstant(NOW, ZoneOffset.UTC), started);
        mvc.perform(multipart(path(started)).file(png()).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CLOSED"));
        mvc.perform(delete(path(started)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict());
        long cancelled = activity(); putCover(cancelled);
        activities.cancel(cancelled, new CancelActivityRequest("测试取消"), adminId());
        mvc.perform(multipart(path(cancelled)).file(png()).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("ACTIVITY_CANCELLED"));
        mvc.perform(delete(path(cancelled)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isConflict());
        mvc.perform(get(imagePath(cancelled))).andExpect(status().isOk());
        mvc.perform(delete(path(Long.MAX_VALUE)).with(user(principal(adminId()))).with(csrf())).andExpect(status().isNotFound());
        mvc.perform(multipart(path(Long.MAX_VALUE)).file(png()).with(user(principal(adminId()))).with(csrf())).andExpect(status().isNotFound());
    }

    @Test void databaseChecksPairHashAndBlobAndEnforceMaximumBytes() throws Exception {
        long id = activity();
        assertThatThrownBy(() -> jdbc.update("UPDATE activities SET cover_hash=? WHERE id=?", "a".repeat(64), id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE activities SET cover_image=? WHERE id=?", png().getBytes(), id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE activities SET cover_image=?,cover_hash=? WHERE id=?", png().getBytes(), "X".repeat(64), id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE activities SET cover_image=?,cover_hash=? WHERE id=?", new byte[ActivityCoverImages.MAX_BYTES + 1], "a".repeat(64), id)).isInstanceOf(DataAccessException.class);
        assertThat(activities.get(id, null).coverUrl()).isNull();
    }

    @Test void auditFailureRollsBackBothUploadAndDelete() throws Exception {
        long id = activity(); var prepared = images.prepare(png());
        queries.failAudit.set(true);
        assertThatThrownBy(() -> covers.replace(id, prepared, adminId())).isInstanceOf(DataAccessException.class);
        assertThat(activities.get(id, null).coverUrl()).isNull(); assertThat(edits(id)).isZero();
        covers.replace(id, prepared, adminId());
        queries.failAudit.set(true);
        assertThatThrownBy(() -> covers.replace(id, null, adminId())).isInstanceOf(DataAccessException.class);
        assertThat(covers.get(id).coverImage()).isEqualTo(prepared.bytes()); assertThat(edits(id)).isEqualTo(1);
    }

    @Test void concurrentDuplicateMutationsAppendOneEventAndSerializeWithCancellation() throws Exception {
        long id = activity(); var prepared = images.prepare(png()); long actor = adminId();
        try (var executor = Executors.newFixedThreadPool(2)) {
            var begin = new CountDownLatch(1);
            var first = executor.submit(() -> { await(begin); return covers.replace(id, prepared, actor); });
            var second = executor.submit(() -> { await(begin); return covers.replace(id, prepared, actor); });
            begin.countDown(); first.get(10, TimeUnit.SECONDS); second.get(10, TimeUnit.SECONDS);
            assertThat(edits(id)).isEqualTo(1);
            var deletedFirst = executor.submit(() -> covers.replace(id, null, actor));
            var deletedSecond = executor.submit(() -> covers.replace(id, null, actor));
            deletedFirst.get(10, TimeUnit.SECONDS); deletedSecond.get(10, TimeUnit.SECONDS); assertThat(edits(id)).isEqualTo(2);
            var locked = new CountDownLatch(1); var release = new CountDownLatch(1);
            queries.afterLock.set(() -> { locked.countDown(); await(release); });
            var upload = executor.submit(() -> covers.replace(id, prepared, actor));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();
            var cancellation = executor.submit(() -> activities.cancel(id, new CancelActivityRequest("并发取消"), actor));
            try { assertThatThrownBy(() -> cancellation.get(150, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class); }
            finally { release.countDown(); }
            upload.get(10, TimeUnit.SECONDS); cancellation.get(10, TimeUnit.SECONDS);
            assertThat(activities.get(id, null).cancelled()).isTrue(); assertThat(covers.get(id).coverHash()).isEqualTo(prepared.hash());
            assertThatThrownBy(() -> covers.replace(id, null, actor)).isInstanceOf(ApiException.class);
        }
    }

    @Test void realServletRejectsFileAboveTwoMibWithTheSameChinese413Json() throws Exception {
        long actor = account("ADMIN"), id = activity();
        var cookies = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
        var client = HttpClient.newBuilder().cookieHandler(cookies).build();
        String base = "http://127.0.0.1:" + port;
        var csrfResponse = client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/csrf")).GET().build(), HttpResponse.BodyHandlers.ofString());
        var token = json.readTree(csrfResponse.body());
        String form = "username=" + URLEncoder.encode(users.findById(actor).username(), StandardCharsets.UTF_8) + "&password=CoverLocal123%21";
        var login = client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/login")).header("Content-Type", "application/x-www-form-urlencoded")
            .header(token.get("headerName").asString(), token.get("token").asString()).POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(login.statusCode()).isEqualTo(200);
        token = json.readTree(client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/csrf")).GET().build(), HttpResponse.BodyHandlers.ofString()).body());
        var body = new ByteArrayOutputStream();
        body.write("--cover-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"oversize.png\"\r\nContent-Type: image/png\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        body.write(new byte[ActivityCoverImages.MAX_BYTES + 1]); body.write("\r\n--cover-boundary--\r\n".getBytes(StandardCharsets.US_ASCII));
        var response = client.send(HttpRequest.newBuilder(URI.create(base + path(id))).header("Content-Type", "multipart/form-data; boundary=cover-boundary")
            .header(token.get("headerName").asString(), token.get("token").asString()).POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(413); assertThat(json.readTree(response.body()).get("message").asString()).isEqualTo("封面图片不能超过 2 MB。");
        assertThat(activities.get(id, null).coverUrl()).isNull(); assertThat(edits(id)).isZero();
    }
    static void await(CountDownLatch latch) {
        try { if (!latch.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out waiting for owned cover transaction"); }
        catch (InterruptedException exception) { Thread.currentThread().interrupt(); throw new IllegalStateException(exception); }
    }
}

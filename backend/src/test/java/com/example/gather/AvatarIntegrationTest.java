package com.example.gather;

import com.example.gather.api.ApiModels.*;
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
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcPrint;
import org.springframework.context.annotation.*;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.ObjectMapper;
import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.CRC32;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL avatar isolation, rollback and authentication, using only this run's owned accounts. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(AvatarIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class AvatarIntegrationTest {
    private static final String PATH = "/api/me/avatar";
    private static final String PASSWORD = "AvatarLocal123!";

    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean AvatarQueries avatarQueries() { return new AvatarQueries(); }
        @Bean @Primary ImageProbe avatarImageProbe() { return new ImageProbe(); }
    }
    static class ImageProbe extends AvatarImages {
        final AtomicBoolean preparedInTransaction = new AtomicBoolean();
        @Override public Prepared prepare(MultipartFile file) {
            preparedInTransaction.set(TransactionSynchronizationManager.isActualTransactionActive());
            return super.prepare(file);
        }
    }
    record Query(String id, String sql, boolean transaction, boolean readOnly) {}
    @Intercepts({@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
        @Signature(type = Executor.class, method = "update", args = {MappedStatement.class, Object.class})})
    static class AvatarQueries implements Interceptor {
        final List<Query> queries = new CopyOnWriteArrayList<>();
        final AtomicBoolean failAfterWrite = new AtomicBoolean();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            queries.add(new Query(statement.getId(), statement.getBoundSql(invocation.getArgs()[1]).getSql(),
                TransactionSynchronizationManager.isActualTransactionActive(), TransactionSynchronizationManager.isCurrentTransactionReadOnly()));
            Object result = invocation.proceed();
            if (statement.getId().endsWith("AvatarMapper.replace") && failAfterWrite.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected avatar failure after update");
            return result;
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Avatar tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"), "activity"));
        properties.add("spring.datasource.password", () -> Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"), "activity_dev_password"));
        properties.add("app.demo-seed-enabled", () -> "true");
        properties.add("app.demo-admin-password", () -> "Admin123!"); properties.add("app.demo-user-password", () -> "Demo123!");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired AvatarService avatars;
    @Autowired ImageProbe images;
    @Autowired AvatarQueries queries;
    @Autowired PasswordEncoder passwords;
    @Autowired ObjectMapper json;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired FavoriteService favorites;
    @LocalServerPort int port;
    final Map<Long, String> fixtureUsers = new LinkedHashMap<>();
    final Map<Long, String> fixtureActivities = new LinkedHashMap<>();
    final List<FavoriteKey> favoriteKeys = new ArrayList<>();

    @BeforeEach void verifyDedicatedV13BeforeWritingFixtures() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()", String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1", Integer.class)).isEqualTo(13);
        jdbc.queryForList("SELECT id,credential_version,avatar_hash,avatar_image FROM users LIMIT 0");
        queries.queries.clear(); queries.failAfterWrite.set(false);
    }
    @AfterEach void deleteOnlyOwnedFixtures() {
        queries.failAfterWrite.set(false);
        fixtureUsers.forEach((id, username) -> assertThat(users.findById(id).username()).isEqualTo(username));
        fixtureActivities.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
        OwnedIntegrationFixtures.remove(jdbc, fixtureActivities.keySet(), fixtureUsers.keySet(), favoriteKeys);
    }
    long account(String role) {
        String username = "avatar_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
        users.insert(username, passwords.encode(PASSWORD), "头像专项账号", role);
        long id = users.findByUsername(username).id(); fixtureUsers.put(id, username); return id;
    }
    AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    static MockMultipartFile png(Color color) throws Exception {
        var image = new BufferedImage(40, 20, BufferedImage.TYPE_INT_ARGB);
        if (color != null) {
            var graphics = image.createGraphics(); graphics.setColor(color); graphics.fillRect(0, 0, 40, 20); graphics.dispose();
        }
        var output = new ByteArrayOutputStream(); ImageIO.write(image, "PNG", output); image.flush();
        return file("头像.png", "image/png", output.toByteArray());
    }
    static MockMultipartFile file(String name, String type, byte[] data) { return new MockMultipartFile("file", name, type, data); }
    UserView upload(long userId, Color color) throws Exception {
        var response = mvc.perform(multipart(PATH).file(png(color)).with(user(principal(userId))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.passwordHash").doesNotExist())
            .andExpect(jsonPath("$.avatarImage").doesNotExist()).andReturn().getResponse();
        return json.readValue(response.getContentAsString(), UserView.class);
    }
    MockHttpSession login(long userId) throws Exception {
        return (MockHttpSession) mvc.perform(post("/api/auth/login").with(csrf()).contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .param("username", fixtureUsers.get(userId)).param("password", PASSWORD))
            .andExpect(status().isOk()).andReturn().getRequest().getSession(false);
    }

    @Test void enforcesAuthenticationCsrfAndTrustedSelfIdentityForEveryMethod() throws Exception {
        long owner = account("USER"), other = account("USER");
        mvc.perform(get(PATH)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(multipart(PATH).file(png(null)).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(delete(PATH).with(csrf())).andExpect(status().isUnauthorized());
        mvc.perform(multipart(PATH).file(png(null)).with(user(principal(owner))))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        mvc.perform(delete(PATH).with(user(principal(owner)))).andExpect(status().isForbidden());
        mvc.perform(multipart(PATH).file(png(null)).param("id", Long.toString(other)).param("userId", Long.toString(other)).param("role", "ADMIN")
                .with(user(principal(owner))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(owner)).andExpect(jsonPath("$.role").value("USER"));
        String hash = users.findById(owner).avatarHash();
        mvc.perform(get(PATH).param("userId", Long.toString(owner)).param("v", hash).with(user(principal(other))))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("AVATAR_NOT_FOUND"));
        mvc.perform(delete(PATH).param("userId", Long.toString(owner)).with(user(principal(other))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(other)).andExpect(jsonPath("$.avatarUrl").isEmpty());
        assertThat(users.findById(owner).avatarHash()).isEqualTo(hash);
    }

    @Test void normalizesBeforeTransactionReturnsOnlyPrivateJpegAndNeverReturns304() throws Exception {
        long owner = account("USER");
        assertThat(users.findById(owner).avatarHash()).isNull();
        mvc.perform(get(PATH).with(user(principal(owner)))).andExpect(status().isNotFound());
        UserView view = upload(owner, null);
        assertThat(images.preparedInTransaction).isFalse();
        assertThat(view.avatarUrl()).isEqualTo(PATH + "?v=" + users.findById(owner).avatarHash()).matches("/api/me/avatar\\?v=[0-9a-f]{64}");
        var result = mvc.perform(get(view.avatarUrl()).with(user(principal(owner))))
            .andExpect(status().isOk()).andExpect(content().contentType("image/jpeg"))
            .andExpect(header().string("Cache-Control", "no-store")).andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andExpect(header().doesNotExist("ETag")).andExpect(header().doesNotExist("Last-Modified"))
            .andReturn().getResponse().getContentAsByteArray();
        assertThat(result).isEqualTo(avatars.get(owner).avatarImage());
        var decoded = ImageIO.read(new ByteArrayInputStream(result));
        assertThat(decoded.getWidth()).isEqualTo(256); assertThat(decoded.getHeight()).isEqualTo(256);
        assertThat(new Color(decoded.getRGB(0, 0))).isEqualTo(Color.WHITE);
        queries.queries.clear();
        mvc.perform(get(view.avatarUrl()).header("If-None-Match", "*").header("If-Modified-Since", "Wed, 01 Jan 2099 00:00:00 GMT")
                .with(user(principal(owner))))
            .andExpect(status().isOk()).andExpect(content().bytes(result));
        assertThat(queries.queries).filteredOn(query -> query.id().endsWith("CredentialVersionMapper.findByUserId"))
            .singleElement().satisfies(query -> assertThat(query.transaction()).isFalse());
        assertThat(queries.queries).filteredOn(query -> query.id().endsWith("AvatarMapper.findByUserId"))
            .singleElement().satisfies(query -> { assertThat(query.transaction()).isTrue(); assertThat(query.readOnly()).isTrue(); });
    }

    @Test void firstReplacementDuplicateAndRepeatedRemovalPreserveExpectedUrlAndCurrentUserView() throws Exception {
        long owner = account("ADMIN");
        var first = upload(owner, Color.BLUE);
        var duplicate = upload(owner, Color.BLUE);
        assertThat(duplicate.avatarUrl()).isEqualTo(first.avatarUrl());
        var replaced = upload(owner, Color.RED);
        assertThat(replaced.avatarUrl()).isNotEqualTo(first.avatarUrl());
        byte[] current = avatars.get(owner).avatarImage();
        mvc.perform(get(first.avatarUrl()).with(user(principal(owner)))).andExpect(status().isOk()).andExpect(content().bytes(current));
        for (int repeat = 0; repeat < 2; repeat++) {
            mvc.perform(delete(PATH).with(user(principal(owner))).with(csrf()))
                .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(owner)).andExpect(jsonPath("$.role").value("ADMIN"))
                .andExpect(jsonPath("$.displayName").value("头像专项账号")).andExpect(jsonPath("$.avatarUrl").isEmpty());
        }
        assertThat(jdbc.queryForMap("SELECT avatar_hash,avatar_image FROM users WHERE id=?", owner).values()).containsOnlyNulls();
        mvc.perform(get(replaced.avatarUrl()).header("If-None-Match", "*").with(user(principal(owner))))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("AVATAR_NOT_FOUND"));
    }

    @Test void separateSessionsReadFreshAvatarWithoutReplacingSecurityContextsCsrfOrCredentialVersion() throws Exception {
        long owner = account("USER");
        var before = users.findById(owner);
        MockHttpSession first = login(owner), second = login(owner);
        String firstId = first.getId(), secondId = second.getId();
        Object firstContext = first.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        Object secondContext = second.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        var token = json.readTree(mvc.perform(get("/api/auth/csrf").session(first)).andReturn().getResponse().getContentAsString());
        var response = mvc.perform(multipart(PATH).file(png(Color.BLUE)).session(first)
                .header(token.get("headerName").asString(), token.get("token").asString()))
            .andExpect(status().isOk()).andReturn().getResponse();
        String url = json.readValue(response.getContentAsString(), UserView.class).avatarUrl();
        for (var session : List.of(first, second)) {
            mvc.perform(get("/api/auth/me").session(session)).andExpect(status().isOk()).andExpect(jsonPath("$.avatarUrl").value(url));
            mvc.perform(get(url).session(session)).andExpect(status().isOk());
        }
        assertThat(first.getId()).isEqualTo(firstId); assertThat(second.getId()).isEqualTo(secondId);
        assertThat(first.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).isSameAs(firstContext);
        assertThat(second.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)).isSameAs(secondContext);
        var unchanged = json.readTree(mvc.perform(get("/api/auth/csrf").session(first)).andReturn().getResponse().getContentAsString());
        assertThat(unchanged.get("token").asString()).isEqualTo(token.get("token").asString());
        assertThat(users.findById(owner).credentialVersion()).isEqualTo(before.credentialVersion());
        assertThat(users.findById(owner).passwordHash()).isEqualTo(before.passwordHash());
        mvc.perform(delete(PATH).session(first).header(token.get("headerName").asString(), token.get("token").asString()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.avatarUrl").isEmpty());
        mvc.perform(get("/api/auth/me").session(second)).andExpect(status().isOk()).andExpect(jsonPath("$.avatarUrl").isEmpty());
    }

    @Test void authLoginAndProfileViewsExposeCurrentHashWithoutReadingAvatarBlob() throws Exception {
        long owner = account("USER");
        var view = upload(owner, Color.BLUE);
        queries.queries.clear();
        mvc.perform(post("/api/auth/login").with(csrf()).contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .param("username", fixtureUsers.get(owner)).param("password", PASSWORD))
            .andExpect(status().isOk()).andExpect(jsonPath("$.avatarUrl").value(view.avatarUrl()));
        mvc.perform(get("/api/auth/me").with(user(principal(owner))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.avatarUrl").value(view.avatarUrl()));
        mvc.perform(patch("/api/me/profile").with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON)
                .content("{\"displayName\":\"新昵称\",\"avatarUrl\":null,\"avatarHash\":null,\"avatarImage\":null}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("新昵称"))
            .andExpect(jsonPath("$.avatarUrl").value(view.avatarUrl()));
        assertThat(queries.queries).isNotEmpty().allSatisfy(query -> assertThat(query.sql().toLowerCase(Locale.ROOT)).doesNotContain("avatar_image", "select *"));
        assertThat(queries.queries).filteredOn(query -> query.id().endsWith("UserMapper.findById") || query.id().endsWith("UserMapper.findByUsername"))
            .isNotEmpty().allSatisfy(query -> assertThat(query.sql()).contains("avatar_hash"));
    }

    @Test void invalidMissingMismatchedOversizedAndPixelBombUploadsPreserveExistingImage() throws Exception {
        long owner = account("USER");
        var view = upload(owner, Color.BLUE); byte[] before = avatars.get(owner).avatarImage();
        byte[] bomb = png(null).getBytes(); ByteBuffer.wrap(bomb).putInt(16, 4096).putInt(20, 4096);
        var crc = new CRC32(); crc.update(bomb, 12, 17); ByteBuffer.wrap(bomb).putInt(29, (int) crc.getValue());
        for (var invalid : List.of(file("x.svg", "image/svg+xml", "<svg/>".getBytes(StandardCharsets.UTF_8)),
            file("x.gif", "image/gif", "GIF89a".getBytes(StandardCharsets.US_ASCII)), file("x.jpg", "image/jpeg", png(null).getBytes()),
            file("x.png", "image/jpeg", png(null).getBytes()), file("x.png", "image/png", new byte[0]),
            file("x.png", "image/png", Arrays.copyOf(png(null).getBytes(), 40)), file("x.png", "image/png", bomb))) {
            mvc.perform(multipart(PATH).file(invalid).with(user(principal(owner))).with(csrf()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_AVATAR"));
        }
        mvc.perform(multipart(PATH).file(file("x.png", "image/png", new byte[AvatarImages.MAX_BYTES + 1])).with(user(principal(owner))).with(csrf()))
            .andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.code").value("UPLOAD_TOO_LARGE"));
        mvc.perform(multipart(PATH).with(user(principal(owner))).with(csrf())).andExpect(status().isBadRequest());
        mvc.perform(post(PATH).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isUnsupportedMediaType()).andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));
        assertThat(avatars.get(owner).avatarImage()).isEqualTo(before);
        assertThat(users.findById(owner).avatarHash()).isEqualTo(view.avatarUrl().substring((PATH + "?v=").length()));
    }

    @Test void failureAfterDatabaseUpdateRollsBackReplacementAndRemoval() throws Exception {
        long owner = account("USER");
        upload(owner, Color.BLUE); var before = avatars.get(owner);
        queries.failAfterWrite.set(true);
        mvc.perform(multipart(PATH).file(png(Color.RED)).with(user(principal(owner))).with(csrf()))
            .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("INTERNAL_ERROR"));
        assertThat(avatars.get(owner).avatarImage()).isEqualTo(before.avatarImage());
        assertThat(avatars.get(owner).avatarHash()).isEqualTo(before.avatarHash());
        queries.failAfterWrite.set(true);
        mvc.perform(delete(PATH).with(user(principal(owner))).with(csrf())).andExpect(status().isInternalServerError());
        assertThat(avatars.get(owner).avatarImage()).isEqualTo(before.avatarImage());
        assertThat(avatars.get(owner).avatarHash()).isEqualTo(before.avatarHash());
    }

    @Test void revokedCredentialCannotReadUploadOrRemoveAvatarAndErrorsStayJson() throws Exception {
        long owner = account("USER"); upload(owner, Color.BLUE);
        var old = principal(owner); var before = avatars.get(owner);
        jdbc.update("UPDATE users SET credential_version=credential_version+1 WHERE id=?", owner);
        mvc.perform(get(PATH).with(user(old))).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        mvc.perform(multipart(PATH).file(png(Color.RED)).with(user(old)).with(csrf()))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        mvc.perform(delete(PATH).with(user(old)).with(csrf())).andExpect(status().isUnauthorized());
        assertThat(avatars.get(owner).avatarImage()).isEqualTo(before.avatarImage());
        assertThat(avatars.get(owner).avatarHash()).isEqualTo(before.avatarHash());
    }

    @Test void databaseConstraintRejectsUnpairedNullInvalidHashEmptyAndOversizedBytes() throws Exception {
        long owner = account("USER"); byte[] image = images.prepare(png(null)).bytes();
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_hash=? WHERE id=?", "a".repeat(64), owner)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_image=? WHERE id=?", image, owner)).isInstanceOf(DataAccessException.class);
        for (String hash : List.of("A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(63) + " ", "")) {
            assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_image=?,avatar_hash=? WHERE id=?", image, hash, owner)).isInstanceOf(DataAccessException.class);
        }
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_image=?,avatar_hash=? WHERE id=?", new byte[0], "a".repeat(64), owner)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_image=?,avatar_hash=? WHERE id=?", new byte[AvatarImages.MAX_BYTES + 1], "a".repeat(64), owner)).isInstanceOf(DataAccessException.class);
        upload(owner, Color.BLUE);
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_hash=NULL WHERE id=?", owner)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE users SET avatar_image=NULL WHERE id=?", owner)).isInstanceOf(DataAccessException.class);
    }

    @Test void avatarMutationsDoNotChangeOtherUsersCredentialsRegistrationsFavoritesNotificationsOrAudit() throws Exception {
        long owner = account("USER"), other = account("USER"), actor = users.findByUsername("admin").id();
        String title = "Avatar " + UUID.randomUUID();
        long activityId = activities.create(new CreateActivityRequest(title, "Owned avatar fixture", "本地会场", Instant.now().plusSeconds(7200), 2), actor).id();
        fixtureActivities.put(activityId, title);
        registrations.register(activityId, owner); favorites.add(owner, activityId); favoriteKeys.add(new FavoriteKey(owner, activityId));
        var before = new LinkedHashMap<String, Object>();
        for (String table : List.of("activities", "registrations", "activity_favorites", "notifications", "activity_audit_logs")) {
            String column = table.equals("activities") ? "id" : "activity_id";
            before.put(table, jdbc.queryForList("SELECT * FROM " + table + " WHERE " + column + "=? ORDER BY id", activityId));
        }
        var ownerBefore = jdbc.queryForMap("SELECT id,username,password_hash,display_name,role,credential_version,created_at FROM users WHERE id=?", owner);
        var otherBefore = users.findById(other);
        upload(owner, Color.BLUE); upload(owner, Color.RED);
        mvc.perform(delete(PATH).with(user(principal(owner))).with(csrf())).andExpect(status().isOk());
        for (String table : before.keySet()) {
            String column = table.equals("activities") ? "id" : "activity_id";
            assertThat(jdbc.queryForList("SELECT * FROM " + table + " WHERE " + column + "=? ORDER BY id", activityId)).isEqualTo(before.get(table));
        }
        assertThat(jdbc.queryForMap("SELECT id,username,password_hash,display_name,role,credential_version,created_at FROM users WHERE id=?", owner)).isEqualTo(ownerBefore);
        assertThat(users.findById(other)).isEqualTo(otherBefore);
    }

    @Test void actualServletEnforcesTwoMibLimitAndKeepsOldAvatarWithSafeJsonMessage() throws Exception {
        long owner = account("USER"); upload(owner, Color.BLUE); var before = avatars.get(owner);
        var client = HttpClient.newBuilder().cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL)).build();
        String base = "http://127.0.0.1:" + port;
        var token = json.readTree(client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/csrf")).GET().build(), HttpResponse.BodyHandlers.ofString()).body());
        String form = "username=" + URLEncoder.encode(fixtureUsers.get(owner), StandardCharsets.UTF_8) + "&password=AvatarLocal123%21";
        var loggedIn = client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/login")).header("Content-Type", "application/x-www-form-urlencoded")
            .header(token.get("headerName").asString(), token.get("token").asString()).POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(loggedIn.statusCode()).isEqualTo(200);
        token = json.readTree(client.send(HttpRequest.newBuilder(URI.create(base + "/api/auth/csrf")).GET().build(), HttpResponse.BodyHandlers.ofString()).body());
        var body = new ByteArrayOutputStream();
        body.write("--avatar-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"oversize.png\"\r\nContent-Type: image/png\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        body.write(new byte[AvatarImages.MAX_BYTES + 1]); body.write("\r\n--avatar-boundary--\r\n".getBytes(StandardCharsets.US_ASCII));
        var response = client.send(HttpRequest.newBuilder(URI.create(base + PATH)).header("Content-Type", "multipart/form-data; boundary=avatar-boundary")
            .header(token.get("headerName").asString(), token.get("token").asString()).POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(413);
        assertThat(json.readTree(response.body()).get("code").asString()).isEqualTo("UPLOAD_TOO_LARGE");
        assertThat(json.readTree(response.body()).get("message").asString()).isEqualTo("图片不能超过 2 MB。");
        assertThat(avatars.get(owner).avatarImage()).isEqualTo(before.avatarImage());
        assertThat(avatars.get(owner).avatarHash()).isEqualTo(before.avatarHash());
    }
}

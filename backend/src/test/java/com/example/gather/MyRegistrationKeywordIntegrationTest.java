package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.api.MyRegistrationModels.*;
import com.example.gather.mapper.CredentialVersionMapper;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Literal keyword predicates, complete personal summaries, and actual InnoDB snapshot isolation. */
@SpringBootTest
@AutoConfigureMockMvc
@Import(MyRegistrationKeywordIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class MyRegistrationKeywordIntegrationTest {
    private static final Instant NOW = Instant.parse("2035-09-01T09:00:00.123456789Z");
    private static final String PATH = "/api/me/registrations/search";

    @TestConfiguration(proxyBeanMethods = false)
    static class Configuration {
        @Bean @Primary KeywordClock keywordClock() { return new KeywordClock(); }
        @Bean KeywordReads keywordReads() { return new KeywordReads(); }
    }

    static class KeywordClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return NOW; }
    }

    record Query(String statement, String sql, List<Object> parameters, boolean readOnly, Integer isolation) {}
    @Intercepts(@Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))
    static class KeywordReads implements Interceptor {
        final AtomicReference<Runnable> afterTotals = new AtomicReference<>();
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            var records = captured.get();
            if (records != null) {
                var bound = statement.getBoundSql(invocation.getArgs()[1]);
                var parameter = statement.getConfiguration().newMetaObject(invocation.getArgs()[1]);
                var values = new ArrayList<Object>();
                for (var mapping : bound.getParameterMappings()) values.add(parameter.getValue(mapping.getProperty()));
                records.add(new Query(statement.getId(), bound.getSql(), values,
                    TransactionSynchronizationManager.isCurrentTransactionReadOnly(),
                    TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            }
            Object result = invocation.proceed();
            if (statement.getId().equals(RegistrationMapper.class.getName() + ".mineTotals")) {
                Runnable action = afterTotals.getAndSet(null);
                if (action != null) action.run();
            }
            return result;
        }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url == null || !url.startsWith("jdbc:mysql:")
            || !java.net.URI.create(url.substring("jdbc:".length())).getPath().equals("/activity_platform_test")) {
            throw new IllegalStateException("Keyword integration tests require the dedicated REAL activity_platform_test MySQL database");
        }
        properties.add("spring.datasource.url", () -> url);
        properties.add("spring.datasource.username", () -> environment("TEST_DB_USERNAME", "activity"));
        properties.add("spring.datasource.password", () -> environment("TEST_DB_PASSWORD", "activity_dev_password"));
        properties.add("app.demo-admin-password", () -> "Admin123!");
        properties.add("app.demo-user-password", () -> "Demo123!");
        properties.add("app.demo-seed-enabled", () -> "true");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityService activities;
    @Autowired RegistrationService registrations;
    @Autowired CheckInService checkIns;
    @Autowired PlatformTransactionManager transactions;
    @Autowired KeywordClock clock;
    @Autowired KeywordReads reads;
    private final Map<Long, String> activityFixtures = new LinkedHashMap<>();
    private final Map<Long, String> userFixtures = new LinkedHashMap<>();

    @BeforeEach
    void verifyDedicatedV12BeforeWritingFixtures() {
        assertThat(jdbc.queryForObject("SELECT DATABASE()", String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT version FROM flyway_schema_history WHERE success=1 ORDER BY installed_rank DESC LIMIT 1", String.class))
            .isEqualTo("12");
        jdbc.queryForList("SELECT id, credential_version FROM users LIMIT 0");
        jdbc.queryForList("SELECT id, category, cover_hash, cover_image, ends_at, registration_deadline FROM activities LIMIT 0");
        jdbc.queryForList("SELECT id, checked_in_at, checked_in_by FROM registrations LIMIT 0");
        jdbc.queryForList("SELECT id, activity_id, actor_user_id, registration_id, changes_json FROM activity_audit_logs LIMIT 0");
        jdbc.queryForList("SELECT id, user_id, activity_id FROM activity_favorites LIMIT 0");
    }

    @AfterEach
    void cleanOnlyExactlyOwnedRowsAfterCheckingOwnershipAndExternalReferences() {
        reads.afterTotals.set(null); reads.captured.remove();
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            activityFixtures.forEach((id, title) -> assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?", String.class, id)).isEqualTo(title));
            userFixtures.forEach((id, name) -> assertThat(jdbc.queryForObject("SELECT username FROM users WHERE id=?", String.class, id)).isEqualTo(name));
            OwnedIntegrationFixtures.remove(jdbc, activityFixtures.keySet(), userFixtures.keySet());
        });
    }

    @Test
    void titleAndLocationContainLiteralWildcardsQuotesBackslashesAndSpacesWithoutTrimming() throws Exception {
        long owner = createUser("USER");
        String literal = "%_ ' \\  双空格";
        long title = register(createActivity("字面" + literal + "标题", "普通会场", 2), owner);
        long location = register(createActivity("普通活动", "会场" + literal + "地点", 2), owner);
        register(createActivity("字面abc标题", "普通会场", 2), owner);
        for (String keyword : List.of("%", "_", "'", "\\", "  ", literal)) {
            var page = registrations.searchMine(owner, 1, 100, "ALL", keyword);
            assertThat(page.total()).as("literal keyword %s", keyword).isEqualTo(2);
            assertThat(page.items()).extracting(MyRegistrationView::id).containsExactlyInAnyOrder(title, location);
            mvc.perform(request(owner).param("keyword", keyword)).andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(2)).andExpect(jsonPath("$.items.length()").value(2));
        }
        for (String keyword : List.of(" 字面", "标题 ", "' OR 1=1 --")) {
            var page = registrations.searchMine(owner, 1, 100, "ALL", keyword);
            assertThat(page.items()).isEmpty(); assertThat(page.total()).isZero();
            assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(3, 0, 0, 0));
        }
    }

    @Test
    void keywordLengthUsesUtf16UnitsAndRejects201BeforeReadingClockOrBusinessData() throws Exception {
        long owner = createUser("USER");
        String ascii200 = "x".repeat(200);
        String pairs200 = "\uD83D\uDE00".repeat(100);
        long ascii = register(createActivity("二百字地点", ascii200, 2), owner);
        long pairs = register(createActivity("代理对地点", pairs200, 2), owner);
        for (var match : Map.of(ascii200, ascii, pairs200, pairs).entrySet()) {
            assertThat(match.getKey()).hasSize(200);
            mvc.perform(request(owner).param("keyword", match.getKey())).andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].id").value(match.getValue()));
        }
        var identity = principal(owner);
        for (String keyword : List.of(ascii200 + "x", pairs200 + "x", "x".repeat(199) + "\uD83D\uDE00")) {
            assertThat(keyword).hasSize(201);
            clock.calls.set(0);
            var queries = capture(() -> {
                try { mvc.perform(get(PATH).with(user(identity)).param("keyword", keyword)).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("VALIDATION_ERROR")); }
                catch (Exception failure) { throw new IllegalStateException(failure); }
            });
            assertThat(clock.calls.get()).isZero();
            assertThat(queries).extracting(Query::statement).containsExactly(CredentialVersionMapper.class.getName() + ".findByUserId");
        }
        assertThatThrownBy(() -> registrations.searchMine(owner, 1, 10, "ALL", null)).isInstanceOf(ApiException.class);
    }

    @Test
    void stateAndKeywordFilterItemsAndTotalWhileEveryPageKeepsTheCompleteAttendanceSummary() {
        long owner = createUser("USER");
        long filler = createUser("USER");
        var matching = new LinkedHashMap<String, List<Long>>();
        matching.put("ACTIVE", new ArrayList<>()); matching.put("WAITING", new ArrayList<>()); matching.put("CANCELLED", new ArrayList<>());
        for (int i = 0; i < 7; i++) {
            boolean match = i == 0 || i == 1 || i == 3 || i == 5;
            long activity = createActivity((match ? "聚会" : "其他") + "活动" + i, "本地", i == 3 || i == 4 ? 1 : 2);
            if (i == 3 || i == 4) register(activity, filler);
            long registration = register(activity, owner);
            String state = i < 3 ? "ACTIVE" : i < 5 ? "WAITING" : "CANCELLED";
            if (state.equals("CANCELLED")) registrations.cancel(activity, owner);
            if (i == 0) { start(activity, NOW.minusSeconds(1)); checkIns.checkIn(activity, registration, adminId()); }
            if (match) matching.get(state).add(registration);
            jdbc.update("UPDATE registrations SET updated_at=? WHERE id=?", utc(NOW), registration);
        }
        for (String state : List.of("ALL", "ACTIVE", "WAITING", "CANCELLED")) {
            var expected = new ArrayList<>(state.equals("ALL") ? matching.values().stream().flatMap(Collection::stream).toList() : matching.get(state));
            expected.sort(Comparator.reverseOrder());
            var seen = new ArrayList<Long>();
            for (int number = 1; number <= expected.size() + 1; number++) {
                var page = registrations.searchMine(owner, number, 1, state, "聚会");
                assertThat(page.total()).isEqualTo(expected.size());
                assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(3, 2, 2, 1));
                assertThat(page.items()).allMatch(item -> state.equals("ALL") || item.status().equals(state));
                seen.addAll(page.items().stream().map(MyRegistrationView::id).toList());
                if (number > expected.size()) assertThat(page.items()).isEmpty();
            }
            assertThat(seen).containsExactlyElementsOf(expected).doesNotHaveDuplicates();
        }
        for (String keyword : List.of("聚会", "没有匹配")) {
            var page = registrations.searchMine(owner, Integer.MAX_VALUE, 100, "ALL", keyword);
            assertThat(page.page()).isEqualTo(Integer.MAX_VALUE); assertThat(page.items()).isEmpty();
            assertThat(page.total()).isEqualTo(keyword.equals("聚会") ? 4 : 0);
            assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(3, 2, 2, 1));
        }
    }

    @Test
    void omittedAndEmptyKeywordsKeepBothLegacyServiceAndHttpContracts() throws Exception {
        long owner = createUser("USER");
        register(createActivity("兼容读取", "本地", 2), owner);
        register(createActivity("另一个活动", "本地", 2), owner);
        assertThat(registrations.searchMine(owner, 1, 10, "ALL", "")).isEqualTo(registrations.searchMine(owner, 1, 10, "ALL"));
        assertThat(registrations.mine(owner)).extracting(RegistrationView::id).containsExactlyElementsOf(
            registrations.searchMine(owner, 1, 10, "ALL", "").items().stream().map(MyRegistrationView::id).toList());
        String omitted = mvc.perform(request(owner)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        String empty = mvc.perform(request(owner).param("keyword", "")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(empty).isEqualTo(omitted);
        mvc.perform(get("/api/me/registrations").with(user(principal(owner))).param("keyword", "不会筛选旧数组"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(2)).andExpect(jsonPath("$[0].length()").value(3));
        long noRegistrations = createUser("USER");
        var noMatch = registrations.searchMine(noRegistrations, 1, 10, "ALL", "兼容");
        assertThat(noMatch.total()).isZero(); assertThat(noMatch.items()).isEmpty();
        assertThat(noMatch.summary()).isEqualTo(new MyRegistrationSummary(0, 0, 0, 0));
    }

    @Test
    void keywordsNeverReadAnotherUsersRowsEvenForAdminOrForgedUserId() throws Exception {
        mvc.perform(get(PATH).param("keyword", "秘密")).andExpect(status().isUnauthorized());
        long owner = createUser("USER");
        long admin = createUser("ADMIN");
        register(createActivity("用户秘密", "本地", 2), owner);
        register(createActivity("管理秘密", "本地", 2), admin);
        for (long identity : List.of(owner, admin)) {
            long other = identity == owner ? admin : owner;
            String othersKeyword = identity == owner ? "管理秘密" : "用户秘密";
            mvc.perform(request(identity).param("keyword", othersKeyword).param("userId", Long.toString(other)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0)).andExpect(jsonPath("$.items").isEmpty())
                .andExpect(jsonPath("$.summary.activeRegistrations").value(1));
        }
    }

    @Test
    void filteredReadUsesTwoReadOnlySelectsAndOneUtcMicrosecondInstant() {
        long owner = createUser("USER");
        long boundary = createActivity("匹配已开始", "本地", 2); register(boundary, owner); start(boundary, NOW.truncatedTo(ChronoUnit.MICROS));
        long next = createActivity("匹配未开始", "本地", 2); register(next, owner); start(next, NOW.truncatedTo(ChronoUnit.MICROS).plus(1, ChronoUnit.MICROS));
        var before = fixtureState();
        clock.calls.set(0);
        var queries = capture(() -> {
            var page = registrations.searchMine(owner, 1, 10, "ACTIVE", "匹配");
            assertThat(page.total()).isEqualTo(2);
            assertThat(page.items()).filteredOn(item -> item.activity().id() == boundary).singleElement().satisfies(item -> assertThat(item.activity().closed()).isTrue());
            assertThat(page.items()).filteredOn(item -> item.activity().id() == next).singleElement().satisfies(item -> assertThat(item.activity().closed()).isFalse());
        });
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(queries).extracting(Query::statement).containsExactly(RegistrationMapper.class.getName() + ".mineTotals", RegistrationMapper.class.getName() + ".searchMine");
        assertThat(queries).allSatisfy(query -> {
            assertThat(query.readOnly()).isTrue();
            assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            assertThat(query.sql()).startsWith("SELECT").contains("LOCATE(?, a.title)", "LOCATE(?, a.location)").doesNotContain("FOR UPDATE", "匹配");
            assertThat(query.parameters()).contains(owner, "ACTIVE", "匹配");
        });
        var identity = principal(owner);
        clock.calls.set(0);
        var httpQueries = capture(() -> {
            try { mvc.perform(get(PATH).with(user(identity)).param("status", "ACTIVE").param("keyword", "匹配"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(2)); }
            catch (Exception failure) { throw new IllegalStateException(failure); }
        });
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(httpQueries).extracting(Query::statement).containsExactly(CredentialVersionMapper.class.getName() + ".findByUserId",
            RegistrationMapper.class.getName() + ".mineTotals", RegistrationMapper.class.getName() + ".searchMine");
        assertThat(httpQueries.getFirst().parameters()).containsExactly(owner);
        assertThat(fixtureState()).isEqualTo(before);
    }

    @Test
    void keywordEditAndRegistrationCancellationCommittedBetweenSelectsStayOutsideTheCurrentSnapshot() {
        long owner = createUser("USER");
        long activity = createActivity("快照旧关键词", "旧会场", 2);
        long registration = register(activity, owner);
        reads.afterTotals.set(() -> {
            assertThat(clock.calls.get()).isEqualTo(1);
            inOtherThread(() -> {
                activities.edit(activity, new EditActivityRequest("快照新关键词", "关键词并发验证", "新会场"), adminId());
                activityFixtures.put(activity, "快照新关键词");
                registrations.cancel(activity, owner);
            });
            clock.calls.set(0);
        });
        clock.calls.set(0);
        var page = registrations.searchMine(owner, 1, 10, "ACTIVE", "旧关键词");
        assertThat(reads.afterTotals.get()).isNull(); assertThat(clock.calls.get()).isZero();
        assertThat(page.total()).isEqualTo(1); assertThat(page.summary()).isEqualTo(new MyRegistrationSummary(1, 0, 0, 0));
        assertThat(page.items()).singleElement().satisfies(item -> {
            assertThat(item.id()).isEqualTo(registration); assertThat(item.status()).isEqualTo("ACTIVE");
            assertThat(item.activity().title()).isEqualTo("快照旧关键词"); assertThat(item.activity().location()).isEqualTo("旧会场");
            assertThat(item.activity().registeredCount()).isEqualTo(1);
        });
        var next = registrations.searchMine(owner, 1, 10, "ACTIVE", "旧关键词");
        assertThat(next.total()).isZero(); assertThat(next.items()).isEmpty();
        assertThat(next.summary()).isEqualTo(new MyRegistrationSummary(0, 0, 1, 0));
        var changed = registrations.searchMine(owner, 1, 10, "CANCELLED", "新关键词");
        assertThat(changed.total()).isEqualTo(1);
        assertThat(changed.items()).singleElement().satisfies(item -> {
            assertThat(item.activity().title()).isEqualTo("快照新关键词"); assertThat(item.activity().location()).isEqualTo("新会场");
            assertThat(item.status()).isEqualTo("CANCELLED"); assertThat(item.activity().registeredCount()).isZero();
        });
    }

    private List<Query> capture(Runnable read) {
        var queries = new ArrayList<Query>(); reads.captured.set(queries);
        try { read.run(); return List.copyOf(queries); }
        finally { reads.captured.remove(); }
    }
    private List<Map<String, Object>> fixtureState() {
        var state = new ArrayList<Map<String, Object>>();
        for (long activity : activityFixtures.keySet()) {
            state.add(jdbc.queryForMap("SELECT * FROM activities WHERE id=?", activity));
            for (String table : List.of("registrations", "notifications", "activity_audit_logs")) {
                state.addAll(jdbc.queryForList("SELECT * FROM " + table + " WHERE activity_id=? ORDER BY id", activity));
            }
        }
        return state;
    }
    private long createActivity(String title, String location, int capacity) {
        long id = activities.create(new CreateActivityRequest(title, "关键词查询验证", location, NOW.plusSeconds(3600), capacity), adminId()).id();
        activityFixtures.put(id, title); return id;
    }
    private long createUser(String role) {
        String username = "mykeyword_" + UUID.randomUUID().toString().replace("-", "");
        users.insert(username, users.findByUsername("demo").passwordHash(), "关键词验证", role);
        long id = users.findByUsername(username).id(); userFixtures.put(id, username); return id;
    }
    private long register(long activity, long member) {
        registrations.register(activity, member);
        return jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?", Long.class, activity, member);
    }
    private MockHttpServletRequestBuilder request(long owner) { return get(PATH).with(user(principal(owner))); }
    private AppUserDetails principal(long owner) { return new AppUserDetails(users.findById(owner)); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private void start(long activity, Instant value) { jdbc.update("UPDATE activities SET starts_at=? WHERE id=?", utc(value), activity); }
    private static LocalDateTime utc(Instant time) { return LocalDateTime.ofInstant(time, ZoneOffset.UTC); }
    private static String environment(String key, String fallback) { String value = System.getenv(key); return value == null ? fallback : value; }
    private static void inOtherThread(Runnable action) {
        try (var worker = Executors.newSingleThreadExecutor()) { worker.submit(action).get(20, TimeUnit.SECONDS); }
        catch (Exception failure) { throw new IllegalStateException("Concurrent fixture changes must commit before the page SELECT", failure); }
    }
}

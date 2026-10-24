package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.FavoriteService;
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
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(FavoriteIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class FavoriteIntegrationTest {
    static final Instant NOW = Instant.parse("2050-10-01T09:00:00.123456789Z");
    static final String MAPPER = "com.example.gather.mapper.FavoriteMapper.";
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary FavoriteClock favoriteClock() { return new FavoriteClock(); }
        @Bean FavoriteQueries favoriteQueries() { return new FavoriteQueries(); }
    }
    static class FavoriteClock extends Clock {
        final AtomicInteger calls = new AtomicInteger();
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return Clock.fixed(NOW, zone); }
        public Instant instant() { calls.incrementAndGet(); return NOW; }
    }
    record Query(String id, boolean readOnly, Integer isolation) {}
    @Intercepts({@Signature(type=Executor.class,method="query",args={MappedStatement.class,Object.class,RowBounds.class,ResultHandler.class}),
        @Signature(type=Executor.class,method="update",args={MappedStatement.class,Object.class})})
    static class FavoriteQueries implements Interceptor {
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        final AtomicReference<Runnable> afterCount = new AtomicReference<>();
        final AtomicBoolean failInsert = new AtomicBoolean();
        public Object intercept(Invocation invocation) throws Throwable {
            String id = ((MappedStatement)invocation.getArgs()[0]).getId();
            if (captured.get()!=null && invocation.getMethod().getName().equals("query")) captured.get().add(new Query(id,
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(), TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            Object value = invocation.proceed();
            if (id.equals(MAPPER+"insert") && failInsert.getAndSet(false)) throw new DataAccessResourceFailureException("Injected favorite write failure");
            if (id.equals(MAPPER+"count")) { var hook=afterCount.getAndSet(null); if(hook!=null) hook.run(); }
            return value;
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url=System.getenv("TEST_DB_URL");
        if(url==null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(java.net.URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Favorite tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url",()->url);
        properties.add("spring.datasource.username",()->Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"),"activity"));
        properties.add("spring.datasource.password",()->Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"),"activity_dev_password"));
        properties.add("app.demo-seed-enabled",()->"true");
        properties.add("app.demo-admin-password",()->"Admin123!"); properties.add("app.demo-user-password",()->"Demo123!");
    }
    @Autowired FavoriteService favorites;
    @Autowired FavoriteClock clock;
    @Autowired FavoriteQueries queries;
    @Autowired JdbcTemplate jdbc;
    @Autowired ActivityMapper activities;
    @Autowired UserMapper users;
    @Autowired MockMvc mvc;
    final Map<Long,String> fixtures=new LinkedHashMap<>();
    final Map<Long,String> userFixtures=new LinkedHashMap<>();
    final List<FavoriteKey> pairs=new ArrayList<>();
    final String prefix="Favorite "+UUID.randomUUID();
    @BeforeEach void gate() {
        com.example.gather.support.OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        assertThat(jdbc.queryForObject("SELECT DATABASE()",String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()",String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1",Integer.class)).isEqualTo(15);
    }
    @AfterEach void cleanup() {
        queries.captured.remove(); queries.afterCount.set(null); queries.failInsert.set(false);
        fixtures.forEach((id,title)->assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?",String.class,id)).isEqualTo(title));
        userFixtures.forEach((id,name)->assertThat(jdbc.queryForObject("SELECT username FROM users WHERE id=?",String.class,id)).isEqualTo(name));
        OwnedIntegrationFixtures.remove(jdbc,fixtures.keySet(),userFixtures.keySet(),pairs);
    }
    long admin() { return users.findByUsername("admin").id(); }
    long demo() { return users.findByUsername("demo").id(); }
    AppUserDetails identity(String name) { return new AppUserDetails(users.findByUsername(name)); }
    long activity() {
        var item=new NewActivity(prefix+" "+fixtures.size(),"Owned favorite fixture","本地会场",LocalDateTime.ofInstant(NOW.plusSeconds(3600),ZoneOffset.UTC),2,admin(),"TECHNOLOGY");
        activities.insert(item); fixtures.put(item.id,item.title); return item.id;
    }
    void own(long user,long activity) { var key=new FavoriteKey(user,activity); if(!pairs.contains(key)) pairs.add(key); }
    com.example.gather.api.FavoriteModels.FavoriteState add(long user,long activity) { own(user,activity); return favorites.add(user,activity); }

    @Test void idempotenceKeepsFirstTimeAndRecollectsWithNewTimeWithoutBusinessEffects() {
        long id=activity();
        var before=jdbc.queryForMap("SELECT registered_count,category,starts_at FROM activities WHERE id=?",id);
        long audits=jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs",Long.class);
        assertThat(favorites.state(demo(),id).favorited()).isFalse();
        assertThat(add(demo(),id).favoritedAt()).isNotNull();
        jdbc.update("UPDATE activity_favorites SET created_at='2001-01-01 00:00:00.123456' WHERE user_id=? AND activity_id=?",demo(),id);
        var first=favorites.state(demo(),id);
        assertThat(add(demo(),id)).isEqualTo(first);
        assertThat(favorites.remove(demo(),id).favorited()).isFalse();
        assertThat(favorites.remove(demo(),id).favoritedAt()).isNull();
        assertThat(add(demo(),id).favoritedAt()).isAfter(first.favoritedAt());
        assertThat(jdbc.queryForMap("SELECT registered_count,category,starts_at FROM activities WHERE id=?",id)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activity_audit_logs",Long.class)).isEqualTo(audits);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM registrations WHERE activity_id=?",Long.class,id)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM notifications WHERE activity_id=?",Long.class,id)).isZero();
    }
    @Test void realUniqueAndForeignKeysProtectFavoriteRows() {
        long id=activity(); add(demo(),id);
        assertThatThrownBy(()->jdbc.update("INSERT INTO activity_favorites(user_id,activity_id) VALUES(?,?)",demo(),id)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(()->jdbc.update("INSERT INTO activity_favorites(user_id,activity_id) VALUES(?,?)",demo(),Long.MAX_VALUE)).isInstanceOf(DataAccessException.class);
        assertThatThrownBy(()->jdbc.update("INSERT INTO activity_favorites(user_id,activity_id) VALUES(?,?)",Long.MAX_VALUE,id)).isInstanceOf(DataAccessException.class);
    }
    @Test void startedAndCancelledActivitiesRemainCollectibleAndReturnCurrentState() {
        long started=activity(), cancelled=activity();
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",LocalDateTime.ofInstant(NOW.minusSeconds(1),ZoneOffset.UTC),started);
        jdbc.update("UPDATE activities SET cancelled_at=UTC_TIMESTAMP(6),cancelled_by=?,cancellation_reason='取消测试' WHERE id=?",admin(),cancelled);
        add(demo(),started); add(demo(),cancelled);
        var page=favorites.page(demo(),1,10);
        assertThat(page.total()).isEqualTo(2);
        assertThat(page.items()).allMatch(item->item.activity().closed());
        assertThat(page.items()).anyMatch(item->item.activity().cancelled() && "取消测试".equals(item.activity().cancellationReason()));
    }
    @Test void httpRequiresIdentityAndCsrfAndIgnoresForgedUser() throws Exception {
        long id=activity(); own(demo(),id);
        mvc.perform(get("/api/me/favorites")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/me/favorites/{id}",id).with(user(identity("demo")))).andExpect(status().isForbidden());
        mvc.perform(post("/api/me/favorites/{id}",id).param("userId",String.valueOf(admin())).with(user(identity("demo"))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.favorited").value(true));
        mvc.perform(get("/api/me/favorites").param("userId",String.valueOf(demo())).with(user(identity("admin"))))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0));
        own(admin(),id);
        mvc.perform(post("/api/me/favorites/{id}",id).with(user(identity("admin"))).with(csrf()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.favorited").value(true));
        mvc.perform(delete("/api/me/favorites/{id}",id).with(user(identity("admin"))).with(csrf())).andExpect(status().isOk());
        assertThat(favorites.state(demo(),id).favorited()).isTrue();
        mvc.perform(get("/api/me/favorites/{id}",id).with(user(identity("demo")))).andExpect(header().exists("X-Request-Id"));
    }
    @Test void missingActivitiesAndInvalidPaginationFailWithoutCreatingRows() throws Exception {
        assertThatThrownBy(()->favorites.add(demo(),Long.MAX_VALUE)).isInstanceOf(ApiException.class);
        assertThatThrownBy(()->favorites.remove(demo(),Long.MAX_VALUE)).isInstanceOf(ApiException.class);
        mvc.perform(get("/api/me/favorites/{id}",Long.MAX_VALUE).with(user(identity("demo")))).andExpect(status().isNotFound());
        for(String value:List.of("0","-1","abc","","2147483648"))
            mvc.perform(get("/api/me/favorites").param("page",value).with(user(identity("demo")))).andExpect(status().isBadRequest());
        mvc.perform(get("/api/me/favorites").param("pageSize","101").with(user(identity("demo")))).andExpect(status().isBadRequest());
        assertThat(favorites.page(demo(),999,10).items()).isEmpty();
    }
    @Test void concurrentCollectAndRemoveAreIdempotent() throws Exception {
        long id=activity(); own(demo(),id);
        try(var pool=Executors.newFixedThreadPool(8)) {
            var start=new CountDownLatch(1);
            var calls=new ArrayList<Future<com.example.gather.api.FavoriteModels.FavoriteState>>();
            long userId=demo();
            for(int n=0;n<20;n++) calls.add(pool.submit(()->{start.await();return favorites.add(userId,id);}));
            start.countDown();
            var first=calls.getFirst().get(15,TimeUnit.SECONDS);
            for(var call:calls) assertThat(call.get(15,TimeUnit.SECONDS)).isEqualTo(first);
            assertThat(favorites.page(userId,1,10).total()).isEqualTo(1);
            calls.clear();
            for(int n=0;n<20;n++) calls.add(pool.submit(()->favorites.remove(userId,id)));
            for(var call:calls) assertThat(call.get(15,TimeUnit.SECONDS).favorited()).isFalse();
            assertThat(favorites.page(userId,1,10).total()).isZero();
        }
    }
    @Test void stablePaginationIncludesCategoryAndOwnRegistrationWithExactlyTwoSnapshotReads() throws Exception {
        var ids=new ArrayList<Long>(); for(int n=0;n<12;n++) {long id=activity();add(demo(),id);ids.add(id);}
        jdbc.update("UPDATE activity_favorites SET created_at='2049-01-01' WHERE user_id=? AND activity_id IN ("+String.join(",",Collections.nCopies(ids.size(),"?"))+")",
            java.util.stream.Stream.concat(java.util.stream.Stream.of(demo()),ids.stream()).toArray());
        long latest=ids.getLast();
        jdbc.update("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,'ACTIVE')",latest,demo());
        jdbc.update("UPDATE activities SET registered_count=1 WHERE id=?",latest);
        long userId=demo(); var principal=identity("demo");
        queries.captured.set(new ArrayList<>()); clock.calls.set(0);
        var page=favorites.page(userId,1,10);
        assertThat(clock.calls.get()).isEqualTo(1);
        var reads=queries.captured.get();
        assertThat(reads).extracting(Query::id).containsExactly(MAPPER+"count",MAPPER+"page");
        assertThat(reads).allMatch(row->row.readOnly() && Objects.equals(row.isolation(),TransactionDefinition.ISOLATION_REPEATABLE_READ));
        assertThat(page.total()).isEqualTo(12); assertThat(page.items()).hasSize(10);
        assertThat(page.items().getFirst().activity().id()).isEqualTo(latest);
        assertThat(page.items().getFirst().activity().registrationStatus()).isEqualTo("ACTIVE");
        assertThat(page.items()).allMatch(row->row.activity().category().equals("TECHNOLOGY"));
        assertThat(favorites.page(userId,2,10).items()).hasSize(2);
        assertThat(favorites.page(userId,3,10).total()).isEqualTo(12);
        queries.captured.get().clear();
        mvc.perform(get("/api/me/favorites").with(user(principal))).andExpect(status().isOk());
        assertThat(queries.captured.get()).extracting(Query::id).containsExactly(
            "com.example.gather.mapper.CredentialVersionMapper.findByUserId",MAPPER+"count",MAPPER+"page");
    }
    @Test void concurrentChangeBetweenCountAndPageUsesOriginalSnapshot() {
        long first=activity(),second=activity(); add(demo(),first); own(demo(),second);
        long userId=demo();
        queries.afterCount.set(()->{
            try(var pool=Executors.newSingleThreadExecutor()) {
                pool.submit(()->{favorites.remove(userId,first);favorites.add(userId,second);}).get(10,TimeUnit.SECONDS);
            } catch(Exception error) {throw new IllegalStateException(error);}
        });
        clock.calls.set(0);
        var page=favorites.page(userId,1,10);
        assertThat(page.total()).isEqualTo(1); assertThat(page.items().getFirst().activity().id()).isEqualTo(first);
        assertThat(clock.calls.get()).isEqualTo(1);
        assertThat(favorites.page(userId,1,10).items().getFirst().activity().id()).isEqualTo(second);
    }
    @Test void failedInsertRollsBackAndExternalFavoritesPreventFixtureDeletion() {
        long id=activity(); own(demo(),id);
        queries.failInsert.set(true);
        assertThatThrownBy(()->favorites.add(demo(),id)).isInstanceOf(DataAccessException.class);
        assertThat(favorites.state(demo(),id).favorited()).isFalse();
        add(demo(),id);
        assertThatThrownBy(()->OwnedIntegrationFixtures.remove(jdbc,fixtures.keySet(),List.of())).isInstanceOf(IllegalStateException.class);
        assertThat(activities.findById(id,null)).isNotNull();
        assertThat(favorites.state(demo(),id).favorited()).isTrue();
    }
    @Test void temporaryUserFavoritingOutsideCleanupScopeRefusesBeforeDeletingAnything() {
        long owned=activity(),outside=activity();
        String name="fav_"+UUID.randomUUID().toString().replace("-","").substring(0,20);
        jdbc.update("INSERT INTO users(username,password_hash,display_name,role) SELECT ?,password_hash,'独立收藏测试','USER' FROM users WHERE username='demo'",name);
        long id=jdbc.queryForObject("SELECT id FROM users WHERE username=?",Long.class,name);userFixtures.put(id,name);
        add(id,outside);
        assertThatThrownBy(()->OwnedIntegrationFixtures.remove(jdbc,List.of(owned),List.of(id))).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM activities WHERE id IN (?,?)",Long.class,owned,outside)).isEqualTo(2);
        assertThat(favorites.state(id,outside).favorited()).isTrue();
    }
}

package com.example.gather;

import com.example.gather.api.ApiException;
import com.example.gather.api.CheckInModels.*;
import com.example.gather.api.ApiModels.CancelActivityRequest;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.mapper.RegistrationMapper;
import com.example.gather.maps.AmapTransport;
import com.example.gather.maps.LocationCoordinateConverter;
import com.example.gather.maps.LocationCheckInConfiguration;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.*;
import com.example.gather.support.OwnedIntegrationFixtures;
import org.apache.ibatis.executor.Executor;
import org.apache.ibatis.mapping.MappedStatement;
import org.apache.ibatis.plugin.*;
import org.apache.ibatis.session.ResultHandler;
import org.apache.ibatis.session.RowBounds;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
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
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real MySQL V15 lock/transaction tests. The upstream transport is an explicit contract substitute, not live AMap. */
@SpringBootTest(properties = "app.maps.web-service-key=offline_geo_web_key_1234567890")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
@Import(GeoCheckInIntegrationTest.Configuration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@ExtendWith(OutputCaptureExtension.class)
class GeoCheckInIntegrationTest {
    private static final Instant NOW = Instant.parse("2049-10-01T09:00:00.123456Z");
    private static final String WEB_KEY = "offline_geo_web_key_1234567890";
    private static final String RAW_LONGITUDE = "116.397123456";
    private static final String RAW_LATITUDE = "39.908123456";
    @TestConfiguration(proxyBeanMethods = false) static class Configuration {
        @Bean @Primary MutableClock geoClock() { return new MutableClock(); }
        @Bean @Primary ContractTransport geoTransport() { return new ContractTransport(); }
        @Bean GeoQueries geoQueries() { return new GeoQueries(); }
    }
    static class MutableClock extends Clock {
        final AtomicReference<Instant> time = new AtomicReference<>(NOW);
        final AtomicInteger calls = new AtomicInteger();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(),zone); }
        @Override public Instant instant() { calls.incrementAndGet(); return time.get(); }
    }
    static class ContractTransport implements AmapTransport {
        final AtomicInteger calls = new AtomicInteger();
        final AtomicReference<String> converted = new AtomicReference<>("116.4,39.9");
        final AtomicReference<Runnable> hook = new AtomicReference<>();
        final AtomicBoolean fail = new AtomicBoolean();
        @Override public Response get(URI uri) {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(uri.getScheme()).isEqualTo("https");
            assertThat(uri.getHost()).isEqualTo("restapi.amap.com");
            assertThat(uri.getPath()).isEqualTo("/v3/assistant/coordinate/convert");
            assertThat(uri.getRawQuery()).contains("coordsys=gps", "output=JSON", "key=" + WEB_KEY)
                .contains("locations=" + RAW_LONGITUDE + "," + RAW_LATITUDE);
            calls.incrementAndGet();
            var action = hook.get(); if (action != null) action.run();
            if (fail.get()) throw new IllegalStateException("Sensitive upstream URI " + uri);
            return new Response(200,"application/json",("{\"status\":\"1\",\"locations\":\"" + converted.get() + "\"}").getBytes(StandardCharsets.UTF_8));
        }
    }
    record Query(String id, String sql, boolean readOnly, Integer isolation) {}
    @Intercepts({@Signature(type=Executor.class,method="query",args={MappedStatement.class,Object.class,RowBounds.class,ResultHandler.class}),
        @Signature(type=Executor.class,method="update",args={MappedStatement.class,Object.class})})
    static class GeoQueries implements Interceptor {
        final AtomicBoolean failAudit = new AtomicBoolean();
        final ThreadLocal<List<Query>> captured = new ThreadLocal<>();
        final AtomicReference<Runnable> afterPreflight = new AtomicReference<>();
        final AtomicReference<Runnable> beforeActivityLock = new AtomicReference<>();
        @Override public Object intercept(Invocation invocation) throws Throwable {
            var statement = (MappedStatement) invocation.getArgs()[0];
            if (statement.getId().endsWith("AuditLogMapper.insert") && failAudit.getAndSet(false))
                throw new DataAccessResourceFailureException("Injected geo attendance audit failure");
            if (captured.get()!=null) captured.get().add(new Query(statement.getId(),statement.getBoundSql(invocation.getArgs()[1]).getSql(),
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(),TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            if(statement.getId().endsWith("ActivityMapper.lockById")){
                var hook=beforeActivityLock.get();if(hook!=null)hook.run();
            }
            var result=invocation.proceed();
            if(statement.getId().endsWith("RegistrationMapper.findLocationCheckInPreflight")){
                var hook=afterPreflight.getAndSet(null);if(hook!=null)hook.run();
            }
            return result;
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties) {
        String url = System.getenv("TEST_DB_URL");
        if (url==null || !url.startsWith("jdbc:mysql:") || !"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Geo check-in tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url",()->url);
        properties.add("spring.datasource.username",()->Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"),"activity"));
        properties.add("spring.datasource.password",()->Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"),"activity_dev_password"));
        properties.add("app.demo-seed-enabled",()->"true");
        properties.add("app.demo-admin-password",()->"Admin123!");
        properties.add("app.demo-user-password",()->"Demo123!");
    }
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired UserMapper users;
    @Autowired ActivityMapper activities;
    @Autowired ActivityService activityService;
    @Autowired LocationCheckInService location;
    @Autowired RegistrationMapper registrationMapper;
    @Autowired LocationCoordinateConverter converter;
    @Autowired LocationCheckInWriter writer;
    @Autowired CheckInService checkIns;
    @Autowired RegistrationService registrations;
    @Autowired AdminService admin;
    @Autowired AuditLogService audit;
    @Autowired MutableClock clock;
    @Autowired ContractTransport transport;
    @Autowired GeoQueries queries;
    final Map<Long,String> fixtureActivities = new LinkedHashMap<>();
    final Map<Long,String> fixtureUsers = new LinkedHashMap<>();
    @BeforeEach void verifyDedicatedV15BeforeWritingFixtures() {
        com.example.gather.support.OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        assertThat(jdbc.queryForObject("SELECT DATABASE()",String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()",String.class)).startsWith("8.4.");
        assertThat(jdbc.queryForObject("SELECT MAX(CAST(version AS UNSIGNED)) FROM flyway_schema_history WHERE success=1",Integer.class)).isEqualTo(15);
        OwnedIntegrationFixtures.verifyLocationPointSchema(jdbc);
    }
    @AfterEach void cleanup() {
        transport.hook.set(null); transport.fail.set(false); transport.converted.set("116.4,39.9"); transport.calls.set(0);
        queries.failAudit.set(false); queries.captured.remove(); queries.afterPreflight.set(null); queries.beforeActivityLock.set(null);
        clock.time.set(NOW); clock.calls.set(0);
        fixtureActivities.forEach((id,title)->assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?",String.class,id)).isEqualTo(title));
        fixtureUsers.forEach((id,username)->assertThat(users.findById(id).username()).isEqualTo(username));
        OwnedIntegrationFixtures.remove(jdbc,fixtureActivities.keySet(),fixtureUsers.keySet());
    }
    @Test void selfRequiresSessionCsrfOwnershipAndValidFieldsWithoutCallingProvider() throws Exception {
        long activity=activity(), owner=account(), other=account(), registration=registration(activity,owner,"ACTIVE");
        String body=json.writeValueAsString(request(0,100));
        mvc.perform(post(selfPath(registration)).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isUnauthorized());
        mvc.perform(post(selfPath(registration)).with(user(principal(owner))).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        for (long id:List.of(registration,Long.MAX_VALUE))
            mvc.perform(post(selfPath(id)).with(user(principal(other))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("REGISTRATION_NOT_FOUND"));
        for (String invalid:List.of("{}", "{\"longitude\":0,\"latitude\":0,\"accuracyMeters\":1}",
            "{\"longitude\":181,\"latitude\":0,\"accuracyMeters\":1,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":-91,\"accuracyMeters\":1,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":0,\"accuracyMeters\":0,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":0,\"accuracyMeters\":100.0001,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":0,\"accuracyMeters\":1,\"expectedVersion\":-1}"))
            mvc.perform(post(selfPath(registration)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(invalid))
                .andExpect(status().isBadRequest());
        assertThat(transport.calls).hasValue(0); assertThat(state(registration).get("check_in_version")).isEqualTo(0L);
    }
    @Test void selfStoresOnlyTrustedMethodAndTimeAndPreservesQueueCountsNotificationsAndPrivateResponse() throws Exception {
        long activity=activity(), owner=account(), registration=registration(activity,owner,"ACTIVE");
        long waiter=registration(activity,account(),"WAITING");
        var before=untouched(activity); var waitingBefore=state(waiter);
        transport.hook.set(()->assertThat(clock.calls).hasValue(0));
        clock.calls.set(0); var observed=new ArrayList<Query>(); queries.captured.set(observed);
        var result=location.checkIn(registration,owner,request(0,100)); queries.captured.remove();
        assertThat(result.checkedInAt()).isEqualTo(NOW); assertThat(result.checkInMethod()).isEqualTo("SELF_LOCATION");
        assertThat(result.checkInVersion()).isEqualTo(1); assertThat(clock.calls).hasValue(1);
        assertThat(untouched(activity)).isEqualTo(before); assertThat(state(waiter)).isEqualTo(waitingBefore);
        assertThat(state(registration).get("checked_in_by")).isNull();
        var locked=observed.stream().filter(query->query.id().endsWith("ActivityMapper.lockById")).findFirst().orElseThrow();
        assertThat(locked.sql()).doesNotContain("location_longitude","location_latitude","ends_at");
        assertThat(locked.isolation()).isEqualTo(TransactionDefinition.ISOLATION_READ_COMMITTED);
        assertThat(observed.stream().filter(query->query.sql().stripLeading().startsWith("SELECT"))
            .map(query->query.id().substring(query.id().lastIndexOf('.')+1)).toList()).containsExactly(
                "findLocationCheckInPreflight","lockById","findMineCheckIn","locationCheckInTarget","context","findMineById");
        var preflight=observed.getFirst();
        assertThat(preflight.sql()).contains("JOIN activities", "r.user_id").doesNotContain("FOR UPDATE", "starts_at");
        assertThat(preflight.isolation()).isNull();
        var event=audit.detail(audit.search(1,10,"CHECK_IN",activity).items().getFirst().id());
        assertThat(event.actorUserId()).isEqualTo(owner); assertThat(event.registrationId()).isEqualTo(registration);
        assertThat(event.occurredAt()).isEqualTo(NOW); assertThat(json.writeValueAsString(event)).contains("SELF_LOCATION").doesNotContain(RAW_LONGITUDE,RAW_LATITUDE,WEB_KEY);
        String response=mvc.perform(post(selfPath(registration)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(request(1,100)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(response).contains("SELF_LOCATION").doesNotContain("checkedInBy","checkInReason",RAW_LONGITUDE,RAW_LATITUDE,WEB_KEY);
        assertThat(transport.calls).hasValue(1); assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isEqualTo(1);
        assertThat(state(registration).get("check_in_version")).isEqualTo(1L);
    }
    @Test void exactStartIsInclusiveEndExclusiveAndMissingEndOrPointNeverWrites() {
        for (int boundary=0; boundary<6; boundary++) {
            long activity=activity(), owner=account(), registration=registration(activity,owner,"ACTIVE");
            if (boundary==0) jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(NOW),activity);
            if (boundary==1) jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(NOW.plusNanos(1000)),activity);
            if (boundary==2) jdbc.update("UPDATE activities SET ends_at=? WHERE id=?",utc(NOW),activity);
            if (boundary==3) jdbc.update("UPDATE activities SET ends_at=? WHERE id=?",utc(NOW.plusNanos(1000)),activity);
            if (boundary==4) jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?",activity);
            if (boundary==5) jdbc.update("UPDATE activities SET location_longitude=NULL,location_latitude=NULL WHERE id=?",activity);
            if (boundary==0 || boundary==3) assertThat(location.checkIn(registration,owner,request(0,1)).checkedInAt()).isEqualTo(NOW);
            else expectCode(()->location.checkIn(registration,owner,request(0,1)),boundary>=4?"LOCATION_CHECK_IN_UNAVAILABLE":"LOCATION_CHECK_IN_CLOSED");
        }
    }
    @Test void convertedDistanceAndAccuracyAreIndependentAndRadiusIncludesOnlyThreeHundredMeters() {
        long activity=activity(); jdbc.update("UPDATE activities SET location_longitude=0,location_latitude=0 WHERE id=?",activity);
        for (String converted:List.of("0.002697960,0","0.002697962,0","0.0035,0")) {
            long owner=account(), registration=registration(activity,owner,"ACTIVE"); transport.converted.set(converted);
            if (converted.startsWith("0.002697960")) assertThat(location.checkIn(registration,owner,request(0,100)).checkInMethod()).isEqualTo("SELF_LOCATION");
            else { expectCode(()->location.checkIn(registration,owner,request(0,100)),"LOCATION_OUT_OF_RANGE"); assertThat(state(registration).get("check_in_version")).isEqualTo(0L); }
        }
        long owner=account(), registration=registration(activity,owner,"ACTIVE"); transport.converted.set("0,0");
        int calls=transport.calls.get(); expectCode(()->location.checkIn(registration,owner,request(0,100.01)),"VALIDATION_ERROR");
        assertThat(transport.calls).hasValue(calls);
    }
    @Test void inactiveCancelledAndStalePreflightNeverWriteAndStaleVersionAvoidsConversion() {
        long activity=activity(), owner=account();
        for(String status:List.of("WAITING","CANCELLED")) { long id=registration(activity,account(),status);
            long user=((Number)state(id).get("user_id")).longValue(); expectCode(()->location.checkIn(id,user,request(0,10)),"REGISTRATION_NOT_ACTIVE"); }
        long id=registration(activity,owner,"ACTIVE"); expectCode(()->location.checkIn(id,owner,request(1,10)),"CHECK_IN_VERSION_CONFLICT");
        assertThat(transport.calls).hasValue(0);
        jdbc.update("UPDATE registrations SET status='CANCELLED' WHERE activity_id=? AND status IN ('ACTIVE','WAITING')",activity);
        jdbc.update("UPDATE activities SET registered_count=0,cancelled_at=?,cancelled_by=?,cancellation_reason='专项取消' WHERE id=?",utc(NOW),adminId(),activity);
        expectCode(()->location.checkIn(id,owner,request(0,10)),"REGISTRATION_NOT_ACTIVE"); assertThat(state(id).get("check_in_version")).isEqualTo(0L);
        assertThat(transport.calls).hasValue(0);
    }
    @Test void writerUsesCurrentWindowAfterConversionAndOneLockedClockReading() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        transport.hook.set(()->clock.time.set(NOW.plusSeconds(3600)));
        clock.calls.set(0); expectCode(()->location.checkIn(id,owner,request(0,10)),"LOCATION_CHECK_IN_CLOSED");
        assertThat(clock.calls).hasValue(1); assertThat(state(id).get("check_in_version")).isEqualTo(0L);
    }
    @Test void missingLocationPrerequisitesRejectBeforeProviderWithOneReadNoClockAndExistingErrorPriority() {
        transport.fail.set(true);
        for(boolean missingEnd:List.of(true,false)) {
            long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
            jdbc.update(missingEnd?"UPDATE activities SET ends_at=NULL WHERE id=?":"UPDATE activities SET location_longitude=NULL,location_latitude=NULL WHERE id=?",activity);
            clock.calls.set(0);
            var observed=new ArrayList<Query>(); queries.captured.set(observed);
            try {expectCode(()->location.checkIn(id,owner,request(0,10)),"LOCATION_CHECK_IN_UNAVAILABLE");}
            finally {queries.captured.remove();}
            assertThat(observed).hasSize(1);
            assertThat(observed.getFirst().id()).endsWith("RegistrationMapper.findLocationCheckInPreflight");
            assertThat(observed.getFirst().sql()).contains("JOIN activities", "r.id", "r.user_id").doesNotContain("FOR UPDATE", "starts_at");
            expectCode(()->location.checkIn(id,owner,request(1,10)),"CHECK_IN_VERSION_CONFLICT");
            expectCode(()->location.checkIn(id,account(),request(0,10)),"REGISTRATION_NOT_FOUND");
            assertThat(transport.calls).hasValue(0); assertThat(clock.calls).hasValue(0);
            assertThat(state(id).get("check_in_version")).isEqualTo(0L); assertThat(state(id).get("checked_in_at")).isNull();
            assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
        }
    }
    @Test void targetChangesDuringConversionAreStillRejectedByLockedWriter() {
        for(int change=0;change<3;change++) {
            long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
            String mutation=switch(change) {
                case 0->"UPDATE activities SET ends_at=NULL WHERE id=?";
                case 1->"UPDATE activities SET location_longitude=NULL,location_latitude=NULL WHERE id=?";
                default->"UPDATE activities SET location_longitude=0,location_latitude=0 WHERE id=?";
            };
            transport.hook.set(()->{assertThat(clock.calls).hasValue(0);jdbc.update(mutation,activity);});
            clock.calls.set(0); int calls=transport.calls.get();
            expectCode(()->location.checkIn(id,owner,request(0,10)),change<2?"LOCATION_CHECK_IN_UNAVAILABLE":"LOCATION_OUT_OF_RANGE");
            assertThat(clock.calls).hasValue(1); assertThat(transport.calls).hasValue(calls+1);
            assertThat(state(id).get("check_in_version")).isEqualTo(0L); assertThat(state(id).get("checked_in_at")).isNull();
            assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
        }
    }
    @Test void activityCancelledDuringConversionCannotBeSignedEvenAfterSuccessfulPreflight() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"), actor=adminId();
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(NOW.plusSeconds(30)),activity);
        transport.hook.set(()->{
            activityService.cancel(activity,new CancelActivityRequest("转换期间正常取消专项"),actor);
            clock.calls.set(0);
        });
        expectCode(()->location.checkIn(id,owner,request(0,10)),"ACTIVITY_CANCELLED");
        assertThat(transport.calls).hasValue(1); assertThat(state(id).get("status")).isEqualTo("CANCELLED");
        assertThat(state(id).get("check_in_version")).isEqualTo(0L); assertThat(state(id).get("checked_in_at")).isNull();
        assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isZero();
        assertThat(audit.search(1,10,"CANCEL",activity).total()).isEqualTo(1);
    }
    @Test void requestBeforeStartMayCrossStartDuringConversionWithoutAnExtraClockRead() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        Instant start=NOW.plusSeconds(30);
        jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(start),activity);
        transport.hook.set(()->{assertThat(clock.calls).hasValue(0);clock.time.set(start);});
        clock.calls.set(0);
        assertThat(location.checkIn(id,owner,request(0,10)).checkedInAt()).isEqualTo(start);
        assertThat(clock.calls).hasValue(1); assertThat(transport.calls).hasValue(1);
        assertThat(state(id).get("check_in_version")).isEqualTo(1L);
    }
    @Test void signedRepeatStillUsesWriterChecksAndNeverCallsProviderAgain() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        location.checkIn(id,owner,request(0,10));
        jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?",activity);
        transport.fail.set(true); clock.calls.set(0);
        var observed=new ArrayList<Query>(); queries.captured.set(observed);
        try {expectCode(()->location.checkIn(id,owner,request(1,10)),"LOCATION_CHECK_IN_UNAVAILABLE");}
        finally {queries.captured.remove();}
        assertThat(observed).extracting(query->query.id().substring(query.id().lastIndexOf('.')+1))
            .containsExactly("findLocationCheckInPreflight","lockById","findMineCheckIn","locationCheckInTarget");
        assertThat(clock.calls).hasValue(1); assertThat(transport.calls).hasValue(1);
        assertThat(state(id).get("check_in_version")).isEqualTo(1L);
        assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isEqualTo(1);
    }
    @Test void saturatedConverterRejectsBeforeWriterAndOtherContendersKeepOneCommittedCheckIn() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        var entered=new CountDownLatch(16); var release=new CountDownLatch(1);
        transport.hook.set(()->{entered.countDown();try {
            if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Timed out waiting for contract release");
        }catch(InterruptedException error){Thread.currentThread().interrupt();throw new IllegalStateException(error);}});
        var pending=new ArrayList<Future<String>>(); var pool=Executors.newFixedThreadPool(16);
        try {
            for(int request=0;request<16;request++)pending.add(pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,10)))));
            assertThat(entered.await(10,TimeUnit.SECONDS)).isTrue();
            var observed=new ArrayList<Query>(); queries.captured.set(observed); clock.calls.set(0);
            try {expectCode(()->location.checkIn(id,owner,request(0,10)),"LOCATION_CHECK_IN_UNAVAILABLE");}
            finally {queries.captured.remove();}
            assertThat(observed).hasSize(1);
            assertThat(observed.getFirst().id()).endsWith("RegistrationMapper.findLocationCheckInPreflight");
            assertThat(clock.calls).hasValue(0); assertThat(transport.calls).hasValue(16);
            assertThat(state(id).get("check_in_version")).isEqualTo(0L); assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
            release.countDown();
            var outcomes=new ArrayList<String>();for(var request:pending)outcomes.add(request.get(20,TimeUnit.SECONDS));
            assertThat(outcomes).filteredOn("OK"::equals).hasSize(1);
            assertThat(outcomes).filteredOn("CHECK_IN_VERSION_CONFLICT"::equals).hasSize(15);
            assertThat(state(id).get("check_in_version")).isEqualTo(1L); assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isEqualTo(1);
        }finally {
            release.countDown(); transport.hook.set(null); pool.shutdownNow(); assertThat(pool.awaitTermination(20,TimeUnit.SECONDS)).isTrue();
        }
    }
    @Test void administratorPostRemainsCompatibleAndPatchRequiresAdminCsrfReasonAndBoxedState() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); String path=adminPath(activity,id);
        String valid="{\"checkedIn\":true,\"reason\":\"核对后补签\",\"expectedVersion\":0}";
        mvc.perform(patch(path).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(valid)).andExpect(status().isForbidden());
        mvc.perform(patch(path).with(user(principal(adminId()))).contentType(MediaType.APPLICATION_JSON).content(valid)).andExpect(status().isForbidden());
        for(String invalid:List.of("{}","{\"reason\":\"原因\",\"expectedVersion\":0}","{\"checkedIn\":false,\"reason\":\"原因\"}",
            "{\"checkedIn\":false,\"reason\":\"  \",\"expectedVersion\":0}","{\"checkedIn\":false,\"reason\":\"多\\n行\",\"expectedVersion\":0}"))
            mvc.perform(patch(path).with(user(principal(adminId()))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(invalid)).andExpect(status().isBadRequest());
        mvc.perform(post(path).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk())
            .andExpect(jsonPath("$.checkInMethod").value("ADMIN")).andExpect(jsonPath("$.checkInVersion").value(1));
        mvc.perform(post(path).with(user(principal(adminId()))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content("{\"expectedVersion\":0}"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("CHECK_IN_VERSION_CONFLICT"));
        mvc.perform(post(path).with(user(principal(adminId()))).with(csrf())).andExpect(status().isOk()).andExpect(jsonPath("$.checkInVersion").value(1));
        assertThat(audit.search(1,10,"ALL",activity).total()).isEqualTo(1);
    }
    @Test void correctionRevokeRetainsAuditHistoryReasonAndVersionThenAllowsNewSelfCheckIn() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); var before=untouched(activity);
        location.checkIn(id,owner,request(0,10));
        var revoked=checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(false,"定位记录有误",1L));
        assertThat(revoked.checkedInAt()).isNull(); assertThat(revoked.checkedInBy()).isNull(); assertThat(revoked.checkInMethod()).isNull(); assertThat(revoked.checkInVersion()).isEqualTo(2);
        var event=audit.detail(audit.search(1,10,"CHECK_IN_REVOKE",activity).items().getFirst().id());
        assertThat(json.writeValueAsString(event)).contains("定位记录有误","SELF_LOCATION",NOW.toString());
        assertThat(checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(false,"重复撤销",2L)).checkInVersion()).isEqualTo(2);
        assertThat(location.checkIn(id,owner,request(2,1)).checkInVersion()).isEqualTo(3);
        assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isEqualTo(2);
        assertThat(audit.search(1,10,"CHECK_IN_REVOKE",activity).total()).isEqualTo(1);
        assertThat(untouched(activity)).isEqualTo(before);
    }
    @Test void adminCanSupplementAndRevokeAfterEndWithoutChangingNoOpVersionOrOriginalActor() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); clock.time.set(NOW.plusSeconds(7200));
        var signed=checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(true,"活动结束后核实补签",0L));
        assertThat(signed.checkInVersion()).isEqualTo(1); assertThat(signed.checkInMethod()).isEqualTo("ADMIN");
        assertThat(checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(true,"重复补签",1L))).isEqualTo(signed);
        assertThat(checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(false,"补签对象有误",1L)).checkInVersion()).isEqualTo(2);
        expectCode(()->location.checkIn(id,owner,request(2,1)),"LOCATION_CHECK_IN_CLOSED");
    }
    @Test void twoConcurrentSelfRequestsProduceOneEventAndOneVersionConflict() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); var barrier=new CyclicBarrier(2);
        transport.hook.set(()->{ try {barrier.await(10,TimeUnit.SECONDS);} catch(Exception error){throw new IllegalStateException(error);} });
        try(var pool=Executors.newFixedThreadPool(2)) {
            var first=pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,10))));
            var second=pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,10))));
            assertThat(List.of(first.get(20,TimeUnit.SECONDS),second.get(20,TimeUnit.SECONDS))).containsExactlyInAnyOrder("OK","CHECK_IN_VERSION_CONFLICT");
        }
        assertThat(state(id).get("check_in_version")).isEqualTo(1L); assertThat(audit.search(1,10,"ALL",activity).total()).isEqualTo(1);
    }
    @Test void lateSelfAfterAdminConfirmAndRevokeCannotResurrectAndFreshVersionCanSignAgain() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        var entered=new CountDownLatch(1); var release=new CountDownLatch(1);
        transport.hook.set(()->{entered.countDown();try { if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Timed out"); } catch(InterruptedException error){Thread.currentThread().interrupt();throw new IllegalStateException(error);} });
        try(var pool=Executors.newSingleThreadExecutor()) {
            var pending=pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,10))));
            assertThat(entered.await(10,TimeUnit.SECONDS)).isTrue();
            checkIns.checkIn(activity,id,adminId(),0L);
            checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(false,"管理员更正",1L));
            release.countDown(); assertThat(pending.get(20,TimeUnit.SECONDS)).isEqualTo("CHECK_IN_VERSION_CONFLICT");
        } finally {release.countDown();transport.hook.set(null);}
        assertThat(state(id).get("checked_in_at")).isNull(); assertThat(state(id).get("check_in_version")).isEqualTo(2L);
        assertThat(location.checkIn(id,owner,request(2,10)).checkInVersion()).isEqualTo(3);
    }
    @Test void selfAndVersionedAdminConfirmationContendOnSameParentLockWithOneWinner() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"), actor=adminId();
        var barrier=new CyclicBarrier(2);
        Runnable start=()->{try{barrier.await(10,TimeUnit.SECONDS);}catch(Exception error){throw new IllegalStateException(error);}};
        transport.hook.set(start);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var self=pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,10))));
            var administrator=pool.submit(()->{start.run();return outcome(()->checkIns.checkIn(activity,id,actor,0L));});
            assertThat(List.of(self.get(20,TimeUnit.SECONDS),administrator.get(20,TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder("OK","CHECK_IN_VERSION_CONFLICT");
        }
        assertThat(state(id).get("check_in_version")).isEqualTo(1L);
        assertThat(audit.search(1,10,"ALL",activity).total()).isEqualTo(1);
        assertThat(state(id).get("check_in_method")).isIn("ADMIN","SELF_LOCATION");
    }
    @Test void auditFailureRollsBackSelfAndRevokeIncludingVersionAndAllOriginalBusinessFields() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); var before=state(id); var business=untouched(activity);
        queries.failAudit.set(true); assertThatThrownBy(()->location.checkIn(id,owner,request(0,10))).isInstanceOf(DataAccessException.class);
        assertThat(state(id)).isEqualTo(before); assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
        checkIns.checkIn(activity,id,adminId(),0L); var signed=state(id);
        queries.failAudit.set(true); assertThatThrownBy(()->checkIns.correct(activity,id,adminId(),new CorrectCheckInRequest(false,"事务回滚验证",1L)))
            .isInstanceOf(DataAccessException.class);
        assertThat(state(id)).isEqualTo(signed); assertThat(audit.search(1,10,"ALL",activity).total()).isEqualTo(1); assertThat(untouched(activity)).isEqualTo(business);
    }
    @Test void strictDatabaseConstraintRejectsUnknownNullPartialInactiveAndNegativeVersions() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        for(String sql:List.of("checked_in_at=UTC_TIMESTAMP(6)","checked_in_by="+adminId(),"check_in_method='ADMIN'",
            "checked_in_at=UTC_TIMESTAMP(6),checked_in_by="+adminId()+",check_in_method=NULL",
            "checked_in_at=UTC_TIMESTAMP(6),checked_in_by=NULL,check_in_method='ADMIN'",
            "checked_in_at=UTC_TIMESTAMP(6),checked_in_by="+adminId()+",check_in_method='SELF_LOCATION'",
            "checked_in_at=UTC_TIMESTAMP(6),checked_in_by=NULL,check_in_method='self_location'",
            "checked_in_at=UTC_TIMESTAMP(6),checked_in_by=NULL,check_in_method='SELF_LOCATION',status='WAITING'","check_in_version=-1"))
            assertThatThrownBy(()->jdbc.update("UPDATE registrations SET "+sql+" WHERE id=?",id)).isInstanceOf(DataAccessException.class);
        assertThat(state(id).get("check_in_method")).isNull(); assertThat(state(id).get("check_in_version")).isEqualTo(0L);
    }
    @Test void mineKeepsTwoReadSnapshotAndSingleClockOldArrayShapeAndCsvAppendsOnlyMethod() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); location.checkIn(id,owner,request(0,1));
        var observed=new ArrayList<Query>(); queries.captured.set(observed); clock.calls.set(0);
        var page=registrations.searchMine(owner,1,10,"ALL"); queries.captured.remove();
        assertThat(observed).hasSize(2).allSatisfy(query->{assertThat(query.readOnly()).isTrue();assertThat(query.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);assertThat(query.sql()).doesNotContain("checked_in_by");});
        assertThat(clock.calls).hasValue(1); assertThat(page.locationCheckInEnabled()).isTrue(); assertThat(page.locationCheckInGcj02Supported()).isTrue();
        assertThat(page.items().getFirst().checkInVersion()).isEqualTo(1);
        assertThat(page.summary().checkedInRegistrations()).isEqualTo(1);
        String old=mvc.perform(get("/api/me/registrations").with(user(principal(owner)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(old).doesNotContain("checkedInAt","checkedInBy","checkInMethod","checkInVersion","locationCheckInEnabled","locationCheckInGcj02Supported");
        String csv=new String(admin.exportRoster(activity,"ALL","ALL",adminId()),StandardCharsets.UTF_8);
        assertThat(csv).contains("\"签到管理员昵称\",\"签到方式\"","\"定位签到\"");
        assertThat(admin.roster(activity,1,10,"ALL",adminId()).items().getFirst().checkedInBy()).isNull();
    }
    @Test void upstreamFailureReturns503WithoutGpsOrWebKeyInResponseOrLogs(CapturedOutput output) throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE"); transport.fail.set(true);
        String response=mvc.perform(post(selfPath(id)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(request(0,10)))).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("LOCATION_CHECK_IN_UNAVAILABLE"))
            .andReturn().getResponse().getContentAsString();
        assertThat(response).doesNotContain(RAW_LONGITUDE,RAW_LATITUDE,WEB_KEY,"Sensitive upstream URI");
        assertThat(output.getAll()).doesNotContain(RAW_LONGITUDE,RAW_LATITUDE,WEB_KEY,"Sensitive upstream URI");
        assertThat(state(id).get("check_in_version")).isEqualTo(0L); assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
    }
    @Test void gcj02RouteRequiresSessionCsrfOwnershipVersionAndAccuracy() throws Exception {
        long activity=compatibilityActivity(), owner=account(), other=account(), id=registration(activity,owner,"ACTIVE");
        String body=json.writeValueAsString(request(0,33));
        mvc.perform(post(gcj02Path(id)).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isUnauthorized());
        mvc.perform(post(gcj02Path(id)).with(user(principal(owner))).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
        for(long target:List.of(id,Long.MAX_VALUE))mvc.perform(post(gcj02Path(target)).with(user(principal(other))).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("REGISTRATION_NOT_FOUND"));
        for(String invalid:List.of("{}",json.writeValueAsString(request(0,100.001)),json.writeValueAsString(request(0,0)),
            "{\"longitude\":181,\"latitude\":0,\"accuracyMeters\":33,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":91,\"accuracyMeters\":33,\"expectedVersion\":0}",
            "{\"longitude\":0,\"latitude\":0,\"accuracyMeters\":33}"))
            mvc.perform(post(gcj02Path(id)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(invalid))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));
        mvc.perform(post(gcj02Path(id)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request(1,33))))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("CHECK_IN_VERSION_CONFLICT"));
        assertThat(transport.calls).hasValue(0);assertThat(state(id).get("check_in_version")).isEqualTo(0L);
    }
    @Test void explicitGcj02UsesOnlyRawPointWhileLegacyAlwaysConvertsTheSameSyntheticInput() throws Exception {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        jdbc.update("UPDATE activities SET location_longitude=116.3971235,location_latitude=39.9082943 WHERE id=?",activity);
        transport.converted.set("116.4043485,39.9082943");
        assertThat(LocationDistance.meters(Double.parseDouble(RAW_LONGITUDE),Double.parseDouble(RAW_LATITUDE),116.3971235,39.9082943)).isBetween(18.0,20.0);
        assertThat(LocationDistance.meters(116.4043485,39.9082943,116.3971235,39.9082943)).isBetween(615.0,617.0);
        var before=untouched(activity);
        // Extra client fields cannot change the fixed WGS84 meaning of the original route.
        String body=json.writeValueAsString(request(0,33));
        String attemptedOverride=body.substring(0,body.length()-1)+",\"coordinateSystem\":\"GCJ02\"}";
        mvc.perform(post(selfPath(id)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(attemptedOverride))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("LOCATION_OUT_OF_RANGE"));
        assertThat(transport.calls).hasValue(1);assertThat(state(id).get("check_in_version")).isEqualTo(0L);
        String response=mvc.perform(post(gcj02Path(id)).with(user(principal(owner))).with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.checkInMethod").value("SELF_LOCATION")).andExpect(jsonPath("$.checkInVersion").value(1))
            .andReturn().getResponse().getContentAsString();
        assertThat(transport.calls).hasValue(1);assertThat(untouched(activity)).isEqualTo(before);
        assertThat(response).doesNotContain("checkedInBy","checkInReason","coordinateSystem",WEB_KEY,RAW_LONGITUDE,RAW_LATITUDE);
        var event=audit.detail(audit.search(1,10,"CHECK_IN",activity).items().getFirst().id());
        assertThat(event.actorUserId()).isEqualTo(owner);
        assertThat(json.writeValueAsString(event)).doesNotContain("GCJ02","WGS84","coordinateSystem",RAW_LONGITUDE,RAW_LATITUDE,WEB_KEY);
    }
    @Test void gcj02DoesNotTryConversionWhenTheDeclaredRawPointIsOutsideTheRadius() {
        long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        assertThat(LocationDistance.meters(Double.parseDouble(RAW_LONGITUDE),Double.parseDouble(RAW_LATITUDE),116.4,39.9)).isGreaterThan(300);
        // The configured contract conversion would land exactly at the target; compatibility must still reject the raw point.
        expectCode(()->location.checkInGcj02(id,owner,request(0,33)),"LOCATION_OUT_OF_RANGE");
        assertThat(transport.calls).hasValue(0);assertThat(state(id).get("check_in_version")).isEqualTo(0L);
        assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
        assertThat(location.checkIn(id,owner,request(0,33)).checkInVersion()).isEqualTo(1);
        assertThat(transport.calls).hasValue(1);
    }
    @Test void gcj02KeepsTimeDistanceAccuracyAndPrerequisiteBoundariesWithoutExternalCalls() {
        transport.fail.set(true);
        var atTarget=new LocationCheckInRequest(BigDecimal.ZERO,BigDecimal.ZERO,BigDecimal.valueOf(100),0L);
        for(int boundary=0;boundary<6;boundary++){
            long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
            jdbc.update("UPDATE activities SET location_longitude=0,location_latitude=0 WHERE id=?",activity);
            if(boundary==0)jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(NOW),activity);
            if(boundary==1)jdbc.update("UPDATE activities SET starts_at=? WHERE id=?",utc(NOW.plusNanos(1000)),activity);
            if(boundary==2)jdbc.update("UPDATE activities SET ends_at=? WHERE id=?",utc(NOW),activity);
            if(boundary==3)jdbc.update("UPDATE activities SET ends_at=? WHERE id=?",utc(NOW.plusNanos(1000)),activity);
            if(boundary==4)jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?",activity);
            if(boundary==5)jdbc.update("UPDATE activities SET location_longitude=NULL,location_latitude=NULL WHERE id=?",activity);
            clock.calls.set(0);
            if(boundary==0||boundary==3)assertThat(location.checkInGcj02(id,owner,atTarget).checkedInAt()).isEqualTo(NOW);
            else expectCode(()->location.checkInGcj02(id,owner,atTarget),boundary>=4?"LOCATION_CHECK_IN_UNAVAILABLE":"LOCATION_CHECK_IN_CLOSED");
            assertThat(clock.calls).hasValue(boundary>=4?0:1);
        }
        for(String longitude:List.of("0.002697960","0.002697962")){
            long activity=activity(), owner=account(), id=registration(activity,owner,"ACTIVE");
            jdbc.update("UPDATE activities SET location_longitude=0,location_latitude=0 WHERE id=?",activity);
            var nearBoundary=new LocationCheckInRequest(new BigDecimal(longitude),BigDecimal.ZERO,BigDecimal.valueOf(100),0L);
            if(longitude.equals("0.002697960"))assertThat(location.checkInGcj02(id,owner,nearBoundary).checkInVersion()).isEqualTo(1);
            else expectCode(()->location.checkInGcj02(id,owner,nearBoundary),"LOCATION_OUT_OF_RANGE");
        }
        assertThat(transport.calls).hasValue(0);
    }
    @Test void bothUnsignedEncodingsRequireReadinessButSignedRepeatsKeepTheOriginalWriterPath() {
        long activity=compatibilityActivity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        var disabled=new LocationCheckInService(registrationMapper,converter,writer,new LocationCheckInConfiguration(""));
        for(Runnable action:List.<Runnable>of(()->disabled.checkIn(id,owner,request(0,33)),()->disabled.checkInGcj02(id,owner,request(0,33)))){
            var observed=new ArrayList<Query>();queries.captured.set(observed);clock.calls.set(0);
            try{assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,error->{
                assertThat(error.status().value()).isEqualTo(503);assertThat(error.code()).isEqualTo("LOCATION_CHECK_IN_UNAVAILABLE");});}
            finally{queries.captured.remove();}
            assertThat(observed).hasSize(1);assertThat(observed.getFirst().id()).endsWith("RegistrationMapper.findLocationCheckInPreflight");
            assertThat(clock.calls).hasValue(0);assertThat(state(id).get("check_in_version")).isEqualTo(0L);
        }
        var signed=checkIns.checkIn(activity,id,adminId(),0L);
        assertThat(disabled.checkIn(id,owner,request(1,33)).checkedInAt()).isEqualTo(signed.checkedInAt());
        assertThat(disabled.checkInGcj02(id,owner,request(1,33)).checkedInAt()).isEqualTo(signed.checkedInAt());
        assertThat(transport.calls).hasValue(0);assertThat(state(id).get("check_in_version")).isEqualTo(1L);
    }
    @Test void gcj02AuditFailureRollsBackVersionAndDoesNotPersistInputEncodingOrCoordinates() {
        long activity=compatibilityActivity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        var before=state(id);var business=untouched(activity);queries.failAudit.set(true);
        assertThatThrownBy(()->location.checkInGcj02(id,owner,request(0,33))).isInstanceOf(DataAccessException.class);
        assertThat(state(id)).isEqualTo(before);assertThat(untouched(activity)).isEqualTo(business);assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
        assertThat(location.checkInGcj02(id,owner,request(0,33)).checkInVersion()).isEqualTo(1);
        assertThat(location.checkInGcj02(id,owner,request(1,33)).checkInVersion()).isEqualTo(1);
        assertThat(transport.calls).hasValue(0);assertThat(audit.search(1,10,"ALL",activity).total()).isEqualTo(1);
        assertThat(state(id).keySet()).doesNotContain("coordinate_system","location_longitude","location_latitude");
    }
    @Test void gcj02StandardAndAdministratorCompeteForOneVersionThenRevokeAndResignNormally() throws Exception {
        long activity=compatibilityActivity(), owner=account(), id=registration(activity,owner,"ACTIVE"), actor=adminId();
        transport.converted.set(RAW_LONGITUDE+","+RAW_LATITUDE);
        var barrier=new CyclicBarrier(3);
        queries.beforeActivityLock.set(()->{try{barrier.await(10,TimeUnit.SECONDS);}catch(Exception error){throw new IllegalStateException(error);}});
        var pool=Executors.newFixedThreadPool(3);
        try{
            var compatible=pool.submit(()->outcome(()->location.checkInGcj02(id,owner,request(0,33))));
            var standard=pool.submit(()->outcome(()->location.checkIn(id,owner,request(0,33))));
            var administrator=pool.submit(()->outcome(()->checkIns.checkIn(activity,id,actor,0L)));
            var outcomes=List.of(compatible.get(20,TimeUnit.SECONDS),standard.get(20,TimeUnit.SECONDS),administrator.get(20,TimeUnit.SECONDS));
            assertThat(outcomes).filteredOn("OK"::equals).hasSize(1);
            assertThat(outcomes).filteredOn("CHECK_IN_VERSION_CONFLICT"::equals).hasSize(2);
        }finally{queries.beforeActivityLock.set(null);pool.shutdownNow();assertThat(pool.awaitTermination(10,TimeUnit.SECONDS)).isTrue();}
        assertThat(transport.calls).hasValue(1);assertThat(state(id).get("check_in_version")).isEqualTo(1L);
        assertThat(audit.search(1,10,"CHECK_IN",activity).total()).isEqualTo(1);
        checkIns.correct(activity,id,actor,new CorrectCheckInRequest(false,"兼容方式并发后撤销",1L));
        expectCode(()->location.checkInGcj02(id,owner,request(0,33)),"CHECK_IN_VERSION_CONFLICT");
        assertThat(location.checkInGcj02(id,owner,request(2,33)).checkInVersion()).isEqualTo(3);
        assertThat(audit.search(1,10,"CHECK_IN_REVOKE",activity).total()).isEqualTo(1);
    }
    @Test void lateGcj02RequestCannotReviveAnAdministratorRevocation() throws Exception {
        long activity=compatibilityActivity(), owner=account(), id=registration(activity,owner,"ACTIVE"), actor=adminId();
        var entered=new CountDownLatch(1);var release=new CountDownLatch(1);
        queries.afterPreflight.set(()->{entered.countDown();try{if(!release.await(10,TimeUnit.SECONDS))throw new IllegalStateException("Timed out waiting for preflight release");}
            catch(InterruptedException error){Thread.currentThread().interrupt();throw new IllegalStateException(error);}});
        var pool=Executors.newSingleThreadExecutor();
        try{
            var pending=pool.submit(()->outcome(()->location.checkInGcj02(id,owner,request(0,33))));
            assertThat(entered.await(10,TimeUnit.SECONDS)).isTrue();
            checkIns.checkIn(activity,id,actor,0L);checkIns.correct(activity,id,actor,new CorrectCheckInRequest(false,"拒绝迟到兼容签到",1L));
            release.countDown();assertThat(pending.get(20,TimeUnit.SECONDS)).isEqualTo("CHECK_IN_VERSION_CONFLICT");
        }finally{release.countDown();queries.afterPreflight.set(null);pool.shutdownNow();assertThat(pool.awaitTermination(10,TimeUnit.SECONDS)).isTrue();}
        assertThat(state(id).get("checked_in_at")).isNull();assertThat(state(id).get("check_in_version")).isEqualTo(2L);
        assertThat(location.checkInGcj02(id,owner,request(2,33)).checkInVersion()).isEqualTo(3);
        assertThat(transport.calls).hasValue(0);
    }
    @Test void gcj02StillRechecksTargetAfterPreflightAndDoesNotCallAnyConverter() {
        long activity=compatibilityActivity(), owner=account(), id=registration(activity,owner,"ACTIVE");
        queries.afterPreflight.set(()->jdbc.update("UPDATE activities SET ends_at=NULL WHERE id=?",activity));
        clock.calls.set(0);expectCode(()->location.checkInGcj02(id,owner,request(0,33)),"LOCATION_CHECK_IN_UNAVAILABLE");
        assertThat(clock.calls).hasValue(1);assertThat(transport.calls).hasValue(0);assertThat(state(id).get("check_in_version")).isEqualTo(0L);
        assertThat(audit.search(1,10,"ALL",activity).total()).isZero();
    }
    private long compatibilityActivity(){
        long id=activity();jdbc.update("UPDATE activities SET location_longitude=?,location_latitude=? WHERE id=?",new BigDecimal(RAW_LONGITUDE),new BigDecimal(RAW_LATITUDE),id);return id;
    }
    private long activity() {
        String title="geo_"+UUID.randomUUID();
        var row=new NewActivity(title,"Owned geo check-in fixture","独立专项会场",utc(NOW.minusSeconds(1)),20,adminId(),"TECHNOLOGY",utc(NOW.plusSeconds(3600)),null,new BigDecimal("116.4"),new BigDecimal("39.9"));
        activities.insert(row);fixtureActivities.put(row.id,title);return row.id;
    }
    private long account() {
        String name="geo_"+UUID.randomUUID().toString().replace("-","");
        users.insert(name,users.findByUsername("demo").passwordHash(),"定位签到专项用户","USER");
        long id=users.findByUsername(name).id();fixtureUsers.put(id,name);return id;
    }
    private long registration(long activity,long user,String status) {
        jdbc.update("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,?)",activity,user,status);
        if(status.equals("ACTIVE"))jdbc.update("UPDATE activities SET registered_count=registered_count+1 WHERE id=?",activity);
        return jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?",Long.class,activity,user);
    }
    private Map<String,Object> untouched(long activity) {
        return Map.of("activity",jdbc.queryForMap("SELECT * FROM activities WHERE id=?",activity),
            "queue",jdbc.queryForList("SELECT id,status,created_at,updated_at FROM registrations WHERE activity_id=? ORDER BY id",activity),
            "notifications",jdbc.queryForList("SELECT * FROM notifications WHERE activity_id=? ORDER BY id",activity));
    }
    private Map<String,Object> state(long registration) { return jdbc.queryForMap("SELECT * FROM registrations WHERE id=?",registration); }
    private long adminId() { return users.findByUsername("admin").id(); }
    private AppUserDetails principal(long id) { return new AppUserDetails(users.findById(id)); }
    private static LocalDateTime utc(Instant instant) { return LocalDateTime.ofInstant(instant,ZoneOffset.UTC); }
    private static LocationCheckInRequest request(long version,double accuracy) { return new LocationCheckInRequest(new BigDecimal(RAW_LONGITUDE),new BigDecimal(RAW_LATITUDE),BigDecimal.valueOf(accuracy),version); }
    private static String selfPath(long id) { return "/api/me/registrations/"+id+"/check-in"; }
    private static String gcj02Path(long id) { return selfPath(id)+"/gcj02"; }
    private static String adminPath(long activity,long id) { return "/api/admin/activities/"+activity+"/registrations/"+id+"/check-in"; }
    private static void expectCode(Runnable action,String code) { assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,error->assertThat(error.code()).isEqualTo(code)); }
    private static String outcome(Runnable action) { try {action.run();return "OK";}catch(ApiException error){return error.code();} }
}

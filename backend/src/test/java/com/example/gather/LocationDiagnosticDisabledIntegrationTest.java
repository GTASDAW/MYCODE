package com.example.gather;

import com.example.gather.mapper.UserMapper;
import com.example.gather.maps.AmapTransport;
import com.example.gather.maps.LocationCheckInConfiguration;
import com.example.gather.security.AppUserDetails;
import com.example.gather.support.OwnedIntegrationFixtures;
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
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.net.URI;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Read-only real MySQL checks for the default-off diagnostic route; no fixtures or coordinate requests are created. */
@SpringBootTest(properties={"app.maps.web-service-key=", "spring.datasource.hikari.maximum-pool-size=4"})
@AutoConfigureMockMvc(print=MockMvcPrint.NONE)
@Import(LocationDiagnosticDisabledIntegrationTest.Configuration.class)
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class LocationDiagnosticDisabledIntegrationTest {
    @TestConfiguration(proxyBeanMethods=false) static class Configuration {
        @Bean @Primary DiagnosticClock diagnosticDisabledClock(){return new DiagnosticClock();}
        @Bean @Primary NoTransport diagnosticDisabledTransport(){return new NoTransport();}
        @Bean DiagnosticQueries diagnosticQueries(){return new DiagnosticQueries();}
    }
    static class DiagnosticClock extends Clock {
        final AtomicInteger calls=new AtomicInteger();
        @Override public ZoneId getZone(){return ZoneOffset.UTC;}
        @Override public Clock withZone(ZoneId zone){return Clock.fixed(instant(),zone);}
        @Override public Instant instant(){calls.incrementAndGet();return Instant.parse("2050-01-01T00:00:00Z");}
    }
    static class NoTransport implements AmapTransport {
        final AtomicInteger calls=new AtomicInteger();
        @Override public Response get(URI uri){calls.incrementAndGet();throw new AssertionError("Disabled diagnostics must not call upstream");}
    }
    record Read(String statement,boolean readOnly,Integer isolation,String operation){}
    @Intercepts({@Signature(type=Executor.class,method="query",args={MappedStatement.class,Object.class,RowBounds.class,ResultHandler.class}),
        @Signature(type=Executor.class,method="update",args={MappedStatement.class,Object.class})})
    static class DiagnosticQueries implements Interceptor {
        final ThreadLocal<List<Read>> captured=new ThreadLocal<>();
        @Override public Object intercept(Invocation invocation)throws Throwable{
            if(captured.get()!=null)captured.get().add(new Read(((MappedStatement)invocation.getArgs()[0]).getId(),
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(),TransactionSynchronizationManager.getCurrentTransactionIsolationLevel(),invocation.getMethod().getName()));
            return invocation.proceed();
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties){
        String url=System.getenv("TEST_DB_URL");
        if(url==null||!url.startsWith("jdbc:mysql:")||!"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Diagnostic default tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url",()->url);
        properties.add("spring.datasource.username",()->Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"),"activity"));
        properties.add("spring.datasource.password",()->Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"),"activity_dev_password"));
        properties.add("app.demo-seed-enabled",()->"true");
        properties.add("app.demo-admin-password",()->"Admin123!");
        properties.add("app.demo-user-password",()->"Demo123!");
    }
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired LocationCheckInConfiguration configuration;
    @Autowired DiagnosticClock clock;
    @Autowired NoTransport transport;
    @Autowired DiagnosticQueries queries;
    @BeforeEach void verifyDedicatedCurrentSchemaAndDefaultConfiguration(){
        assertThat(jdbc.queryForObject("SELECT DATABASE()",String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()",String.class)).startsWith("8.4.");
        OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        assertThat(configuration.enabled()).isFalse();assertThat(configuration.gcj02DiagnosticEnabled()).isFalse();
    }
    @AfterEach void releaseReadCapture(){queries.captured.remove();clock.calls.set(0);assertThat(transport.calls).hasValue(0);}
    @Test void clientPayloadQueryOrHeaderCannotEnableDiagnosticAndOnlyAuthenticationReadsTheDatabase()throws Exception{
        var principal=new AppUserDetails(users.findByUsername("demo"));
        var before=businessCounts();
        for(String override:List.of("",",\"gcj02DiagnosticEnabled\":true,\"diagnosticEnabled\":true,\"coordinateSystem\":\"GCJ02\"")){
            var observed=new ArrayList<Read>();queries.captured.set(observed);clock.calls.set(0);
            try{
                mvc.perform(post("/api/me/registrations/9223372036854775807/check-in/gcj02").with(user(principal)).with(csrf())
                    .param("gcj02DiagnosticEnabled","true").param("app.maps.gcj02-diagnostic-enabled","true").header("AMAP_GCJ02_DIAGNOSTIC_ENABLED","true")
                    .contentType(MediaType.APPLICATION_JSON).content("{\"longitude\":1,\"latitude\":2,\"accuracyMeters\":33,\"expectedVersion\":0"+override+"}"))
                    .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("LOCATION_DIAGNOSTIC_DISABLED"))
                    .andExpect(jsonPath("$.message").value("定位兼容诊断未启用，请使用正常签到或联系管理员现场确认。"));
            }finally{queries.captured.remove();}
            assertThat(observed).hasSize(1);assertThat(observed.getFirst().statement()).endsWith("CredentialVersionMapper.findByUserId");
            assertThat(observed.getFirst().operation()).isEqualTo("query");assertThat(clock.calls).hasValue(0);
        }
        assertThat(businessCounts()).isEqualTo(before);assertThat(transport.calls).hasValue(0);
    }
    @Test void defaultPageAdvertisesBothFlagsFalseWithUnchangedTwoReadSnapshotAndLegacyArray()throws Exception{
        var principal=new AppUserDetails(users.findByUsername("demo"));
        var observed=new ArrayList<Read>();queries.captured.set(observed);clock.calls.set(0);
        try{
            mvc.perform(get("/api/me/registrations/search").with(user(principal))).andExpect(status().isOk())
                .andExpect(jsonPath("$.locationCheckInEnabled").value(false)).andExpect(jsonPath("$.locationCheckInGcj02Supported").value(false));
        }finally{queries.captured.remove();}
        assertThat(observed).extracting(read->read.statement().substring(read.statement().lastIndexOf('.')+1))
            .containsExactly("findByUserId","mineTotals","searchMine");
        assertThat(observed.subList(1,observed.size())).allSatisfy(read->{
            assertThat(read.readOnly()).isTrue();assertThat(read.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);
            assertThat(read.operation()).isEqualTo("query");});
        assertThat(clock.calls).hasValue(1);
        mvc.perform(get("/api/me/registrations").with(user(principal))).andExpect(status().isOk())
            .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("locationCheckInGcj02Supported"))));
    }
    @Test void disabledDiagnosticsDoNotOverrideTheNormalRouteOrAuthenticationAndCsrf()throws Exception{
        var principal=new AppUserDetails(users.findByUsername("demo"));
        String body="{\"longitude\":1,\"latitude\":2,\"accuracyMeters\":33,\"expectedVersion\":0}";
        mvc.perform(post("/api/me/registrations/9223372036854775807/check-in").with(user(principal)).with(csrf())
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("REGISTRATION_NOT_FOUND"));
        mvc.perform(post("/api/me/registrations/1/check-in/gcj02").with(csrf()).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/me/registrations/1/check-in/gcj02").with(user(principal)).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("CSRF_INVALID"));
    }
    private Map<String,Long> businessCounts(){
        var result=new LinkedHashMap<String,Long>();
        for(String table:List.of("users","activities","registrations","notifications","activity_audit_logs","activity_favorites"))
            result.put(table,jdbc.queryForObject("SELECT COUNT(*) FROM "+table,Long.class));
        return result;
    }
}

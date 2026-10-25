package com.example.gather;

import com.example.gather.api.AdminModels.*;
import com.example.gather.api.ApiException;
import com.example.gather.api.CheckInModels.CorrectCheckInRequest;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.AdminService;
import com.example.gather.service.CheckInService;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Dedicated real MySQL: shared method filters preserve roster/export snapshots and current summary semantics. */
@SpringBootTest(properties="spring.datasource.hikari.maximum-pool-size=4")
@AutoConfigureMockMvc(print=MockMvcPrint.NONE)
@Import(RosterMethodIntegrationTest.Configuration.class)
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class RosterMethodIntegrationTest {
    static final Instant NOW=Instant.parse("2050-03-01T09:00:00.123456Z");
    static final String DESCRIPTION="Owned roster method fixture";
    @TestConfiguration(proxyBeanMethods=false) static class Configuration {
        @Bean @Primary CountingClock rosterMethodClock(){return new CountingClock();}
        @Bean MethodReads methodReads(){return new MethodReads();}
    }
    static class CountingClock extends Clock {
        final AtomicInteger calls=new AtomicInteger();
        @Override public ZoneId getZone(){return ZoneOffset.UTC;}
        @Override public Clock withZone(ZoneId zone){return Clock.fixed(instant(),zone);}
        @Override public Instant instant(){calls.incrementAndGet();return NOW;}
    }
    record Read(String statement,String sql,boolean readOnly,Integer isolation){}
    @Intercepts(@Signature(type=Executor.class,method="query",args={MappedStatement.class,Object.class,RowBounds.class,ResultHandler.class}))
    static class MethodReads implements Interceptor {
        final ThreadLocal<List<Read>> captured=new ThreadLocal<>();
        final AtomicReference<Runnable> afterCount=new AtomicReference<>();
        @Override public Object intercept(Invocation invocation)throws Throwable {
            var statement=(MappedStatement)invocation.getArgs()[0];
            if(captured.get()!=null)captured.get().add(new Read(statement.getId(),statement.getBoundSql(invocation.getArgs()[1]).getSql(),
                TransactionSynchronizationManager.isCurrentTransactionReadOnly(),TransactionSynchronizationManager.getCurrentTransactionIsolationLevel()));
            var result=invocation.proceed();
            if(statement.getId().endsWith("AdminMapper.countRoster")){var hook=afterCount.getAndSet(null);if(hook!=null)hook.run();}
            return result;
        }
    }
    @DynamicPropertySource static void database(DynamicPropertyRegistry properties){
        String url=System.getenv("TEST_DB_URL");
        if(url==null||!url.startsWith("jdbc:mysql:")||!"/activity_platform_test".equals(URI.create(url.substring(5)).getPath()))
            throw new IllegalStateException("Roster method tests require dedicated real MySQL activity_platform_test");
        properties.add("spring.datasource.url",()->url);
        properties.add("spring.datasource.username",()->Objects.requireNonNullElse(System.getenv("TEST_DB_USERNAME"),"activity"));
        properties.add("spring.datasource.password",()->Objects.requireNonNullElse(System.getenv("TEST_DB_PASSWORD"),"activity_dev_password"));
        properties.add("app.demo-seed-enabled",()->"true");
        properties.add("app.demo-admin-password",()->"Admin123!");
        properties.add("app.demo-user-password",()->"Demo123!");
    }
    @Autowired JdbcTemplate jdbc;
    @Autowired UserMapper users;
    @Autowired ActivityMapper activities;
    @Autowired AdminService admin;
    @Autowired CheckInService checkIns;
    @Autowired MockMvc mvc;
    @Autowired CountingClock clock;
    @Autowired MethodReads reads;
    final Map<Long,String> ownedActivities=new LinkedHashMap<>();
    final Map<Long,String> ownedUsers=new LinkedHashMap<>();
    record Seed(long id,long userId,String username,String displayName,String status,String method,LocalDateTime updatedAt,long version){}
    record Fixture(long activity,List<Seed> rows){}
    @BeforeEach void verifyCurrentSchemaBeforeWrites(){
        assertThat(jdbc.queryForObject("SELECT DATABASE()",String.class)).isEqualTo("activity_platform_test");
        assertThat(jdbc.queryForObject("SELECT VERSION()",String.class)).startsWith("8.4.");
        OwnedIntegrationFixtures.verifyRegistrationCheckInSchema(jdbc);
        OwnedIntegrationFixtures.verifyLocationPointSchema(jdbc);
    }
    @AfterEach void cleanOnlyProvenFixtureIds(){
        reads.afterCount.set(null);reads.captured.remove();clock.calls.set(0);
        ownedActivities.forEach((id,title)->assertThat(jdbc.queryForObject("SELECT title FROM activities WHERE id=?",String.class,id)).isEqualTo(title));
        ownedUsers.forEach((id,name)->assertThat(users.findById(id).username()).isEqualTo(name));
        OwnedIntegrationFixtures.remove(jdbc,ownedActivities.keySet(),ownedUsers.keySet());
    }
    @Test void mixedMethodsCombineWithBothStatusesKeywordAndStablePaginationWithoutFilteringSummary(){
        var fixture=mixedFixture();var summary=new RosterSummaryView(6,4,2);long actor=adminId();
        for(String status:List.of("ALL","ACTIVE","WAITING","CANCELLED"))
            for(String checkIn:List.of("ALL","CHECKED_IN","NOT_CHECKED_IN"))
                for(String method:List.of("ALL","SELF_LOCATION","ADMIN")){
                    var expected=matching(fixture,status,checkIn,method,"共同方式");
                    var page=admin.roster(fixture.activity(),1,1,status,checkIn,"共同方式",method,actor);
                    assertThat(page.total()).isEqualTo(expected.size());assertThat(page.summary()).isEqualTo(summary);
                    assertThat(page.items()).extracting(RosterView::id).containsExactlyElementsOf(expected.stream().limit(1).map(Seed::id).toList());
                    var all=new ArrayList<Long>();
                    for(int number=1;number<=Math.max(1,(expected.size()+1)/2);number++){
                        var next=admin.roster(fixture.activity(),number,2,status,checkIn,"共同方式",method,actor);
                        assertThat(next.total()).isEqualTo(expected.size());assertThat(next.summary()).isEqualTo(summary);
                        next.items().forEach(row->all.add(row.id()));
                    }
                    assertThat(all).containsExactlyElementsOf(expected.stream().map(Seed::id).toList());
                    var beyond=admin.roster(fixture.activity(),Integer.MAX_VALUE,100,status,checkIn,"共同方式",method,actor);
                    assertThat(beyond.items()).isEmpty();assertThat(beyond.total()).isEqualTo(expected.size());assertThat(beyond.summary()).isEqualTo(summary);
                    assertCsv(admin.exportRoster(fixture.activity(),status,checkIn,"共同方式",method,actor),expected);
                }
        assertThat(admin.roster(fixture.activity(),1,100,"ALL","ALL","","ALL",actor).items())
            .filteredOn(row->row.checkInMethod()==null).hasSize(4);
        assertThat(admin.roster(fixture.activity(),1,100,"ALL","ALL","","ADMIN",actor).items())
            .anySatisfy(row->assertThat(row.checkInVersion()).isZero());
    }
    @Test void methodAndKeywordUseLiteralBoundUnicodePunctuationAndCurrentNames(){
        var fixture=mixedFixture();var target=fixture.rows().getFirst();long actor=adminId();
        for(String keyword:List.of(target.username(),"中文%_","引号'","反斜线\\","😀","两  空格")){
            var page=admin.roster(fixture.activity(),1,10,"ACTIVE","CHECKED_IN",keyword,"SELF_LOCATION",actor);
            assertThat(page.items()).extracting(RosterView::id).containsExactly(target.id());
            assertThat(page.summary()).isEqualTo(new RosterSummaryView(6,4,2));
            assertCsv(admin.exportRoster(fixture.activity(),"ACTIVE","CHECKED_IN",keyword,"SELF_LOCATION",actor),List.of(target));
        }
        for(String keyword:List.of("x' OR 1=1 --","%X","两 空格","中文%_ "))
            assertThat(admin.roster(fixture.activity(),1,10,"ALL","ALL",keyword,"SELF_LOCATION",actor).items()).isEmpty();
        jdbc.update("UPDATE users SET display_name=? WHERE id=?","最新方式昵称",target.userId());
        assertThat(admin.roster(fixture.activity(),1,10,"ALL","ALL","最新方式","SELF_LOCATION",actor).items())
            .extracting(RosterView::id).containsExactly(target.id());
    }
    @Test void originalServiceAndHttpDefaultsStayAllWhileExplicitEmptyUnknownAndUnauthorizedRequestsFail()throws Exception{
        var fixture=mixedFixture();long id=fixture.activity(),actor=adminId();
        var trusted=principal(actor);
        var all=admin.roster(id,1,10,"ALL","ALL","","ALL",actor);
        assertThat(admin.roster(id,1,10,"ALL",actor)).isEqualTo(all);
        assertThat(admin.roster(id,1,10,"ALL","ALL",actor)).isEqualTo(all);
        assertThat(admin.roster(id,1,10,"ALL","ALL","",actor)).isEqualTo(all);
        assertThat(admin.exportRoster(id,"ALL","ALL",actor)).containsExactly(admin.exportRoster(id,"ALL","ALL","","ALL",actor));
        assertThat(admin.exportRoster(id,"ALL","ALL","",actor)).containsExactly(admin.exportRoster(id,"ALL","ALL","","ALL",actor));
        for(String path:List.of(rosterPath(id),rosterPath(id)+"/export")){
            mvc.perform(get(path).param("checkInMethod","SELF_LOCATION")).andExpect(status().isUnauthorized());
            mvc.perform(get(path).with(user(principal(users.findByUsername("demo").id()))).param("checkInMethod","ADMIN")).andExpect(status().isForbidden());
            var omitted=mvc.perform(get(path).with(user(principal(actor)))).andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
            mvc.perform(get(path).with(user(principal(actor))).param("checkInMethod","ALL")).andExpect(status().isOk()).andExpect(content().bytes(omitted));
            for(String invalid:List.of(""," ","admin","self_location","UNKNOWN")){
                var observed=capture(()->{
                    try{mvc.perform(get(path).with(user(trusted)).param("checkInMethod",invalid))
                        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("VALIDATION_ERROR"));}
                    catch(Exception error){throw new IllegalStateException(error);}
                });
                assertThat(observed).hasSize(1);assertThat(observed.getFirst().statement()).endsWith("CredentialVersionMapper.findByUserId");
            }
        }
        for(String invalid:Arrays.asList(null,"","ADMIN ","OTHER")){
            var observed=capture(()->{
                expectValidation(()->admin.roster(id,1,10,"ALL","ALL","",invalid,actor));
                expectValidation(()->admin.exportRoster(id,"ALL","ALL","",invalid,actor));
            });
            assertThat(observed).isEmpty();
        }
        var expected=matching(fixture,"ALL","ALL","SELF_LOCATION","");
        mvc.perform(get(rosterPath(id)).with(user(principal(actor))).param("checkInMethod","SELF_LOCATION"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(expected.size()));
        mvc.perform(get(rosterPath(id)+"/export").with(user(principal(actor))).param("checkInMethod","SELF_LOCATION").param("page","99").param("pageSize","1"))
            .andExpect(status().isOk()).andExpect(content().contentType("text/csv;charset=UTF-8"))
            .andExpect(content().bytes(admin.exportRoster(id,"ALL","ALL","","SELF_LOCATION",actor)));
    }
    @Test void methodFilterAddsNoSelectAndRetainsReadonlyIsolationAndOneRosterClock(){
        var fixture=mixedFixture();long actor=adminId();
        for(boolean exporting:List.of(false,true)){
            clock.calls.set(0);
            var observed=capture(()->{
                if(exporting)admin.exportRoster(fixture.activity(),"ACTIVE","CHECKED_IN","共同方式","SELF_LOCATION",actor);
                else admin.roster(fixture.activity(),1,10,"ACTIVE","CHECKED_IN","共同方式","SELF_LOCATION",actor);
            });
            assertThat(observed).extracting(read->read.statement().substring(read.statement().lastIndexOf('.')+1))
                .containsExactlyElementsOf(exporting?List.of("findById","countRoster","roster"):List.of("findById","rosterSummary","countRoster","roster"));
            assertThat(observed).allSatisfy(read->{assertThat(read.readOnly()).isTrue();assertThat(read.isolation()).isEqualTo(TransactionDefinition.ISOLATION_REPEATABLE_READ);});
            assertThat(clock.calls).hasValue(exporting?0:1);
            assertThat(observed).filteredOn(read->read.statement().endsWith(".countRoster")||read.statement().endsWith(".roster"))
                .allSatisfy(read->assertThat(read.sql()).contains("r.check_in_method = ?","LOCATE(?, u.username)","LOCATE(?, u.display_name)")
                    .doesNotContain("SELF_LOCATION","共同方式"));
            assertThat(observed).filteredOn(read->read.statement().endsWith(".rosterSummary"))
                .allSatisfy(read->assertThat(read.sql()).doesNotContain("check_in_method"));
        }
    }
    @Test void committedMethodChangesBetweenCountAndRowsAppearOnlyOnNextSnapshotForRosterAndExport(){
        long actor=adminId();
        for(boolean exporting:List.of(false,true)){
            long activity=activity();var target=seed(activity,"ACTIVE","SELF_LOCATION","快照方式",0);
            reads.afterCount.set(()->inOtherThread(()->{
                checkIns.correct(activity,target.id(),actor,new CorrectCheckInRequest(false,"方式筛选快照更正",target.version()));
                checkIns.checkIn(activity,target.id(),actor,target.version()+1);
            }));
            if(exporting){
                var csv=admin.exportRoster(activity,"ALL","ALL","快照方式","SELF_LOCATION",actor);
                assertCsv(csv,List.of(target));assertThat(new String(csv,StandardCharsets.UTF_8)).contains("定位签到").doesNotContain("管理员签到");
            }else{
                var page=admin.roster(activity,1,10,"ALL","ALL","快照方式","SELF_LOCATION",actor);
                assertThat(page.total()).isEqualTo(1);assertThat(page.items()).singleElement().satisfies(row->{
                    assertThat(row.id()).isEqualTo(target.id());assertThat(row.checkInMethod()).isEqualTo("SELF_LOCATION");});
                assertThat(page.summary()).isEqualTo(new RosterSummaryView(1,1,0));
            }
            assertThat(admin.roster(activity,1,10,"ALL","ALL","快照方式","SELF_LOCATION",actor).total()).isZero();
            assertThat(admin.roster(activity,1,10,"ALL","ALL","快照方式","ADMIN",actor).items()).extracting(RosterView::id).containsExactly(target.id());
        }
    }
    private Fixture mixedFixture(){
        long activity=activity();var rows=new ArrayList<Seed>();
        rows.add(seed(activity,"ACTIVE","SELF_LOCATION","共同方式 中文%_引号'反斜线\\😀 两  空格",0));
        rows.add(seed(activity,"ACTIVE","SELF_LOCATION","共同方式 定位二",1));
        rows.add(seed(activity,"ACTIVE","ADMIN","共同方式 历史管理员",2));
        rows.add(seed(activity,"ACTIVE","ADMIN","共同方式 管理员二",3));
        rows.add(seed(activity,"ACTIVE",null,"不匹配关键词",4));
        rows.add(seed(activity,"ACTIVE",null,"共同方式 历史空方式",5));
        rows.add(seed(activity,"WAITING",null,"共同方式 候补",6));
        rows.add(seed(activity,"CANCELLED",null,"共同方式 取消",7));
        return new Fixture(activity,rows);
    }
    private long activity(){
        String title="RosterMethod "+UUID.randomUUID();var row=new NewActivity(title,DESCRIPTION,"独立名单方式会场",utc(NOW.minusSeconds(60)),20,adminId());
        activities.insert(row);ownedActivities.put(row.id,title);return row.id;
    }
    private Seed seed(long activity,String status,String method,String name,int order){
        String username="rostermethod_"+UUID.randomUUID().toString().replace("-","");
        users.insert(username,users.findByUsername("demo").passwordHash(),name,"USER");
        long userId=users.findByUsername(username).id();ownedUsers.put(userId,username);
        var updated=utc(NOW.minusSeconds(order==0?10:30));long version="SELF_LOCATION".equals(method)?1:0;
        jdbc.update("INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at,checked_in_at,checked_in_by,check_in_method,check_in_version) VALUES(?,?,?,?,?,?,?,?,?)",
            activity,userId,status,utc(NOW.minusSeconds(120)),updated,method==null?null:utc(NOW.minusSeconds(5)),"ADMIN".equals(method)?adminId():null,method,version);
        if(status.equals("ACTIVE"))jdbc.update("UPDATE activities SET registered_count=registered_count+1 WHERE id=?",activity);
        long id=jdbc.queryForObject("SELECT id FROM registrations WHERE activity_id=? AND user_id=?",Long.class,activity,userId);
        return new Seed(id,userId,username,name,status,method,updated,version);
    }
    private static List<Seed> matching(Fixture fixture,String status,String checkIn,String method,String keyword){
        return fixture.rows().stream().filter(row->status.equals("ALL")||status.equals(row.status()))
            .filter(row->checkIn.equals("ALL")||row.status().equals("ACTIVE")&&(checkIn.equals("CHECKED_IN")?row.method()!=null:row.method()==null))
            .filter(row->method.equals("ALL")||method.equals(row.method()))
            .filter(row->keyword.isEmpty()||row.username().contains(keyword)||row.displayName().contains(keyword))
            .sorted(Comparator.comparing(Seed::updatedAt).reversed().thenComparing(Comparator.comparingLong(Seed::id).reversed())).toList();
    }
    private static void assertCsv(byte[] bytes,List<Seed> expected){
        String csv=new String(bytes,StandardCharsets.UTF_8);assertThat(csv).startsWith("\uFEFF\"报名记录ID\"").endsWith("\r\n");
        var lines=csv.split("\r\n");assertThat(lines).hasSize(expected.size()+1);
        assertThat(lines[0].split(",")).hasSize(11);assertThat(lines[0]).endsWith("\"签到管理员昵称\",\"签到方式\"");
        for(int index=0;index<expected.size();index++)assertThat(lines[index+1]).startsWith("\"\t"+expected.get(index).id()+"\",");
    }
    private List<Read> capture(Runnable action){var observed=new ArrayList<Read>();reads.captured.set(observed);try{action.run();}finally{reads.captured.remove();}return observed;}
    private static void inOtherThread(Runnable action){try(var pool=Executors.newSingleThreadExecutor()){try{pool.submit(action).get(15,TimeUnit.SECONDS);}catch(Exception error){throw new IllegalStateException("Concurrent method change failed",error);}}}
    private long adminId(){return users.findByUsername("admin").id();}
    private AppUserDetails principal(long id){return new AppUserDetails(users.findById(id));}
    private static String rosterPath(long id){return "/api/admin/activities/"+id+"/registrations";}
    private static LocalDateTime utc(Instant instant){return LocalDateTime.ofInstant(instant,ZoneOffset.UTC);}
    private static void expectValidation(Runnable action){assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,error->{assertThat(error.status().value()).isEqualTo(400);assertThat(error.code()).isEqualTo("VALIDATION_ERROR");});}
}

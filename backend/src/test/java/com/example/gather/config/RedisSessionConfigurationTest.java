package com.example.gather.config;

import com.example.gather.domain.UserRow;
import com.example.gather.security.AppUserDetails;
import com.example.gather.security.CurrentSessionLogout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.session.autoconfigure.SessionAutoConfiguration;
import org.springframework.boot.web.server.autoconfigure.ServerProperties;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.HashOperations;
import org.springframework.data.redis.core.RedisOperations;
import org.springframework.data.redis.serializer.JdkSerializationRedisSerializer;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.web.csrf.DefaultCsrfToken;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.Session;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.HttpSessionIdResolver;
import org.springframework.session.web.http.CookieHttpSessionIdResolver;
import org.springframework.session.MapSession;
import org.springframework.session.MapSessionRepository;
import org.springframework.session.web.http.SessionRepositoryFilter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class RedisSessionConfigurationTest {
    @AfterEach void clearThreadAuthentication() { SecurityContextHolder.clearContext(); }
    private final WebApplicationContextRunner context = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(SessionAutoConfiguration.class))
        .withUserConfiguration(RedisSessionConfiguration.class)
        .withBean(RedisConnectionFactory.class, () -> mock(RedisConnectionFactory.class))
        .withInitializer(application -> {
            application.getEnvironment().setActiveProfiles("redis");
            // Match an embedded server before its ServletContext is created, rather than a WAR deployment.
            application.setServletContext(null);
        })
        .withPropertyValues("spring.session.data.redis.namespace=gather:test:session",
            "server.servlet.session.timeout=3s", "server.servlet.session.cookie.name=JSESSIONID",
            "server.servlet.session.cookie.path=/", "server.servlet.session.cookie.http-only=true",
            "server.servlet.session.cookie.same-site=lax", "server.servlet.session.cookie.secure=false");

    @Test
    void optInRepositoryUsesActualServerTimeoutAndBootRegistersOneSessionFilter() {
        context.run(application -> {
            assertThat(application).hasNotFailed().hasSingleBean(RedisSessionRepository.class)
                .hasSingleBean(SessionRepositoryFilter.class);
            Session session = application.getBean(RedisSessionRepository.class).createSession();
            assertThat(session.getMaxInactiveInterval()).isEqualTo(Duration.ofSeconds(3));
            assertThat(application).hasBean("sessionRepositoryFilterRegistration");
        });
    }

    @Test
    void completeRedisSessionUsesDefaultMappingWithoutChangingIdentityCsrfOrTimes() {
        RedisOperations<String, Object> redis = mock(RedisOperations.class);
        HashOperations<String, Object, Object> hashes = mock(HashOperations.class);
        when(redis.<Object, Object>opsForHash()).thenReturn(hashes);
        var fields = completeFields();
        when(hashes.entries("gather:test:session:sessions:complete")).thenReturn(fields);

        Session session = configuredRepository(redis).findById("complete");

        assertThat(session).isNotNull();
        assertThat(session.getId()).isEqualTo("complete");
        assertThat(session.getCreationTime()).isEqualTo(Instant.ofEpochMilli((Long) fields.get("creationTime")));
        assertThat(session.getLastAccessedTime()).isEqualTo(Instant.ofEpochMilli((Long) fields.get("lastAccessedTime")));
        assertThat(session.getMaxInactiveInterval()).isEqualTo(Duration.ofSeconds(1800));
        assertThat(session.getAttributeNames()).containsExactlyInAnyOrder("SPRING_SECURITY_CONTEXT", "csrf");
        assertThat((Object) session.getAttribute("SPRING_SECURITY_CONTEXT")).isSameAs(fields.get("sessionAttr:SPRING_SECURITY_CONTEXT"));
        assertThat((Object) session.getAttribute("csrf")).isSameAs(fields.get("sessionAttr:csrf"));
        verify(redis, never()).delete(anyString());
    }

    @Test
    void missingOrNullRequiredMetadataReturnsNoSessionAndRepositoryDeletesOnlyItsExactHash() {
        for (String missing : List.of("creationTime", "lastAccessedTime", "maxInactiveInterval")) {
            for (boolean explicitNull : new boolean[] {false, true}) {
                RedisOperations<String, Object> redis = mock(RedisOperations.class);
                HashOperations<String, Object, Object> hashes = mock(HashOperations.class);
                when(redis.<Object, Object>opsForHash()).thenReturn(hashes);
                var fields = completeFields();
                if (explicitNull) fields.put(missing, null);
                else fields.remove(missing);
                String id = missing + explicitNull;
                String key = "gather:test:session:sessions:" + id;
                when(hashes.entries(key)).thenReturn(fields);

                assertThat(configuredRepository(redis).findById(id)).as("%s null=%s", missing, explicitNull).isNull();

                verify(hashes).entries(key);
                verify(redis).delete(key);
                verifyNoMoreInteractions(hashes);
                verify(redis, times(1)).delete(anyString());
            }
        }
    }

    @Test
    void completeMetadataTypeErrorsStillFollowTheDefaultMapperAndAreNotDeleted() {
        RedisOperations<String, Object> redis = mock(RedisOperations.class);
        HashOperations<String, Object, Object> hashes = mock(HashOperations.class);
        when(redis.<Object, Object>opsForHash()).thenReturn(hashes);
        var fields = completeFields(); fields.put("creationTime", "invalid-time-type");
        when(hashes.entries("gather:test:session:sessions:bad-type")).thenReturn(fields);

        assertThatThrownBy(() -> configuredRepository(redis).findById("bad-type")).isInstanceOf(ClassCastException.class);

        verify(redis, never()).delete(anyString());
    }

    @Test
    void redisReadAndIncompleteHashDeleteFailuresPropagateRatherThanBecomingAnonymousSuccess() {
        RedisOperations<String, Object> redis = mock(RedisOperations.class);
        HashOperations<String, Object, Object> hashes = mock(HashOperations.class);
        when(redis.<Object, Object>opsForHash()).thenReturn(hashes);
        var failedRead = new org.springframework.dao.DataAccessResourceFailureException("test-only read failure");
        when(hashes.entries("gather:test:session:sessions:read-failure")).thenThrow(failedRead);
        var repository = configuredRepository(redis);
        assertThatThrownBy(() -> repository.findById("read-failure")).isSameAs(failedRead);
        verify(redis, never()).delete(anyString());

        var incomplete = completeFields(); incomplete.remove("creationTime");
        when(hashes.entries("gather:test:session:sessions:delete-failure")).thenReturn(incomplete);
        var failedDelete = new org.springframework.dao.DataAccessResourceFailureException("test-only delete failure");
        when(redis.delete("gather:test:session:sessions:delete-failure")).thenThrow(failedDelete);
        assertThatThrownBy(() -> repository.findById("delete-failure")).isSameAs(failedDelete);
    }

    private static RedisSessionRepository configuredRepository(RedisOperations<String, Object> redis) {
        var repository = new RedisSessionRepository(redis);
        repository.setRedisKeyNamespace("gather:test:session");
        var server = new ServerProperties(); server.getServlet().getSession().setTimeout(Duration.ofSeconds(3));
        new RedisSessionConfiguration().redisSessionTimeout(server).customize(repository);
        return repository;
    }

    private static Map<Object, Object> completeFields() {
        var fields = new HashMap<Object, Object>();
        long now = Instant.now().toEpochMilli();
        fields.put("creationTime", now - 1000); fields.put("lastAccessedTime", now); fields.put("maxInactiveInterval", 1800);
        var principal = new AppUserDetails(new UserRow(42L, "demo", "unused-hash", "演示用户", "USER", 9));
        var authentication = UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities());
        fields.put("sessionAttr:SPRING_SECURITY_CONTEXT", new SecurityContextImpl(authentication));
        fields.put("sessionAttr:csrf", new DefaultCsrfToken("X-CSRF-TOKEN", "_csrf", "test-token"));
        return fields;
    }

    @Test
    void sharedSessionCookieRetainsExistingNamePathAndSecurityFlags() {
        context.run(application -> {
            assertThat(application).hasNotFailed().hasSingleBean(CookieSerializer.class);
            var request = new MockHttpServletRequest();
            var response = new MockHttpServletResponse();
            application.getBean(CookieSerializer.class)
                .writeCookieValue(new CookieSerializer.CookieValue(request, response, "session-id"));
            assertThat(response.getHeader("Set-Cookie")).startsWith("JSESSIONID=")
                .contains("Path=/", "HttpOnly", "SameSite=Lax").doesNotContain("Secure");
        });
        context.withPropertyValues("server.servlet.session.cookie.secure=true").run(application -> {
            var request = new MockHttpServletRequest();
            var response = new MockHttpServletResponse();
            application.getBean(CookieSerializer.class)
                .writeCookieValue(new CookieSerializer.CookieValue(request, response, "session-id"));
            assertThat(response.getHeader("Set-Cookie")).contains("Secure", "HttpOnly", "SameSite=Lax");
        });
    }

    @Test
    void defaultRedisSerializerRoundTripsTrustedIdentityAndCsrfWithoutPassword() {
        String hash = "hash-must-not-be-stored";
        var principal = new AppUserDetails(new UserRow(42L, "demo", hash, "演示用户", "USER", 9));
        var authentication = UsernamePasswordAuthenticationToken.authenticated(principal, "plain-password",
            principal.getAuthorities());
        authentication.eraseCredentials();
        var security = new SecurityContextImpl(authentication);
        var csrf = new DefaultCsrfToken("X-CSRF-TOKEN", "_csrf", "rotated-token");
        var serializer = new JdkSerializationRedisSerializer();
        byte[] payload = serializer.serialize(Map.of("SPRING_SECURITY_CONTEXT", security, "csrf", csrf));

        assertThat(new String(payload, StandardCharsets.ISO_8859_1)).doesNotContain(hash, "plain-password");
        Map<?, ?> restored = (Map<?, ?>) serializer.deserialize(payload);
        var restoredAuthentication = ((SecurityContextImpl) restored.get("SPRING_SECURITY_CONTEXT")).getAuthentication();
        var restoredPrincipal = (AppUserDetails) restoredAuthentication.getPrincipal();
        assertThat(restoredAuthentication.isAuthenticated()).isTrue();
        assertThat(restoredAuthentication.getCredentials()).isNull();
        assertThat(restoredPrincipal.getPassword()).isNull();
        assertThat(restoredPrincipal.id()).isEqualTo(42L);
        assertThat(restoredPrincipal.credentialVersion()).isEqualTo(9L);
        assertThat(restoredPrincipal.view().displayName()).isEqualTo("演示用户");
        assertThat(restoredPrincipal.getAuthorities()).extracting("authority").containsExactly("ROLE_USER");
        assertThat(((DefaultCsrfToken) restored.get("csrf")).getToken()).isEqualTo("rotated-token");
    }

    @Test
    void logicalRevocationClearsServerCredentialsPreservesAdmittedContextAndSessionKeyWhileExplicitLogoutExpires() {
        context.run(application -> {
            assertThat(application).hasNotFailed().hasSingleBean(CookieSerializer.class);
            var repository = new MapSessionRepository(new ConcurrentHashMap<>());
            var resolver = new CookieHttpSessionIdResolver();
            resolver.setCookieSerializer(application.getBean(CookieSerializer.class));
            for (boolean passwordRevocation : new boolean[] {true, false}) {
                var principal = new AppUserDetails(new UserRow(42, "test", "dummy-hash", "测试", "USER", 0));
                var authentication = UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities());
                var admitted = new SecurityContextImpl(authentication);
                MapSession session = repository.createSession();
                session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, admitted);
                repository.save(session);
                var cookieResponse = new MockHttpServletResponse();
                resolver.setSessionId(new MockHttpServletRequest(), cookieResponse, session.getId());
                String header = cookieResponse.getHeader("Set-Cookie");
                assertThat(header.startsWith("JSESSIONID=") && header.contains("Path=/") && header.contains("HttpOnly") && header.contains("SameSite=Lax"))
                    .as("Boot session cookie settings remain intact").isTrue();
                String cookie = header.substring("JSESSIONID=".length(), header.indexOf(';'));
                var request = new MockHttpServletRequest("POST", passwordRevocation ? "/api/me/password" : "/api/auth/logout");
                request.setCookies(new Cookie("JSESSIONID", cookie));
                var response = new MockHttpServletResponse();
                var filter = new SessionRepositoryFilter<MapSession>(repository); filter.setHttpSessionIdResolver(resolver);
                filter.doFilter(request, response, (incoming, outgoing) -> {
                    var sessionRequest = (HttpServletRequest) incoming;
                    var tokenRepository = new HttpSessionCsrfTokenRepository();
                    tokenRepository.saveToken(tokenRepository.generateToken(sessionRequest), sessionRequest, (HttpServletResponse) outgoing);
                    SecurityContextHolder.setContext(admitted);
                    new RequestAttributeSecurityContextRepository().saveContext(admitted, sessionRequest, (HttpServletResponse) outgoing);
                    if (passwordRevocation) {
                        new CurrentSessionLogout().logout(sessionRequest, (HttpServletResponse) outgoing, authentication);
                        assertThat(SecurityContextHolder.getContext().getAuthentication() == null).as("Current request loses authentication").isTrue();
                        assertThat(admitted.getAuthentication() == authentication).as("Other admitted requests retain their original context").isTrue();
                        var requestContext = (org.springframework.security.core.context.SecurityContext) sessionRequest
                            .getAttribute(RequestAttributeSecurityContextRepository.DEFAULT_REQUEST_ATTR_NAME);
                        assertThat(requestContext.getAuthentication() == null).as("Current request dispatch cannot reuse old authentication").isTrue();
                        assertThat(sessionRequest.getSession(false).getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY) == null)
                            .as("Server session no longer contains authentication").isTrue();
                        assertThat(tokenRepository.loadToken(sessionRequest) == null).as("Previous CSRF token is removed").isTrue();
                    } else new SecurityContextLogoutHandler().logout(sessionRequest, (HttpServletResponse) outgoing, authentication);
                });
                if (passwordRevocation) {
                    assertThat(repository.findById(session.getId()) != null).as("Anonymous session key remains available for admitted late saves").isTrue();
                    assertThat(repository.findById(session.getId()).getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY) == null).isTrue();
                    assertThat(response.getHeader("Set-Cookie") == null).as("Logical revocation does not change the browser cookie").isTrue();
                } else {
                    assertThat(repository.findById(session.getId()) == null).as("Explicit logout still removes the session").isTrue();
                    assertThat(response.getHeader("Set-Cookie").contains("JSESSIONID=") && response.getHeader("Set-Cookie").contains("Max-Age=0"))
                        .as("Explicit logout still expires its cookie").isTrue();
                }
                SecurityContextHolder.clearContext();
            }
        });
    }
}

package com.example.gather.config;

import com.example.gather.domain.UserRow;
import com.example.gather.security.AppUserDetails;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.session.autoconfigure.SessionAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.serializer.JdkSerializationRedisSerializer;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.web.csrf.DefaultCsrfToken;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.Session;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.SessionRepositoryFilter;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class RedisSessionConfigurationTest {
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
        var principal = new AppUserDetails(new UserRow(42L, "demo", hash, "演示用户", "USER"));
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
        assertThat(restoredPrincipal.view().displayName()).isEqualTo("演示用户");
        assertThat(restoredPrincipal.getAuthorities()).extracting("authority").containsExactly("ROLE_USER");
        assertThat(((DefaultCsrfToken) restored.get("csrf")).getToken()).isEqualTo("rotated-token");
    }
}

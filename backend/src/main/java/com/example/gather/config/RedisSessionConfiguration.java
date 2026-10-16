package com.example.gather.config;

import org.springframework.boot.web.server.autoconfigure.ServerProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.session.config.SessionRepositoryCustomizer;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.data.redis.config.annotation.web.http.EnableRedisHttpSession;
import com.example.gather.security.CurrentSessionLogout;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.beans.factory.config.BeanPostProcessor;
import java.util.List;

/** Shared servlet Sessions only when explicitly running with the redis profile. */
@Configuration(proxyBeanMethods = false)
@Profile("redis")
@EnableRedisHttpSession(redisNamespace = "${spring.session.data.redis.namespace}")
public class RedisSessionConfiguration {
    @Bean
    static BeanPostProcessor revocationSafeSessionCookies() {
        return new BeanPostProcessor() {
            @Override public Object postProcessAfterInitialization(Object bean, String name) {
                if (!(bean instanceof CookieSerializer serializer)) return bean;
                // Leave Boot's serializer construction/customizers and default resolver detection intact.
                return new CookieSerializer() {
                    @Override public List<String> readCookieValues(HttpServletRequest request) { return serializer.readCookieValues(request); }
                    @Override public void writeCookieValue(CookieValue value) {
                        boolean revoked = Boolean.TRUE.equals(value.getRequest().getAttribute(CurrentSessionLogout.PRESERVE_BROWSER_COOKIE));
                        if (!(revoked && value.getCookieMaxAge() == 0)) serializer.writeCookieValue(value);
                    }
                };
            }
        };
    }

    @Bean
    SessionRepositoryCustomizer<RedisSessionRepository> redisSessionTimeout(ServerProperties server) {
        // The annotation otherwise uses its own 30-minute default, ignoring server.servlet.session.timeout.
        return repository -> repository.setDefaultMaxInactiveInterval(server.getServlet().getSession().getTimeout());
    }
}

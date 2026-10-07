package com.example.gather.config;

import org.springframework.boot.web.server.autoconfigure.ServerProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.session.config.SessionRepositoryCustomizer;
import org.springframework.session.data.redis.RedisSessionRepository;
import org.springframework.session.data.redis.config.annotation.web.http.EnableRedisHttpSession;

/** Shared servlet Sessions only when explicitly running with the redis profile. */
@Configuration(proxyBeanMethods = false)
@Profile("redis")
@EnableRedisHttpSession(redisNamespace = "${spring.session.data.redis.namespace}")
public class RedisSessionConfiguration {
    @Bean
    SessionRepositoryCustomizer<RedisSessionRepository> redisSessionTimeout(ServerProperties server) {
        // The annotation otherwise uses its own 30-minute default, ignoring server.servlet.session.timeout.
        return repository -> repository.setDefaultMaxInactiveInterval(server.getServlet().getSession().getTimeout());
    }
}

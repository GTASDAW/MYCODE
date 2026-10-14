package com.example.gather.security.ratelimit;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.data.redis.core.StringRedisTemplate;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class AuthRateLimitConfigurationTest {
    private final ApplicationContextRunner context = new ApplicationContextRunner()
        .withUserConfiguration(AuthRateLimitConfiguration.class)
        .withPropertyValues("app.auth-rate-limit.login-source-limit=60", "app.auth-rate-limit.login-source-window-seconds=60",
            "app.auth-rate-limit.login-pair-limit=10", "app.auth-rate-limit.login-pair-window-seconds=60",
            "app.auth-rate-limit.register-source-limit=5", "app.auth-rate-limit.register-source-window-seconds=600",
            "app.auth-rate-limit.max-buckets=10000", "app.auth-rate-limit.namespace=gather:test:limits");

    @Test
    void defaultMemoryAndExplicitRedisAreMutuallyExclusiveAndNoFilterIsServletBean() {
        context.run(application -> {
            assertThat(application).hasNotFailed().hasSingleBean(AuthRateLimitStore.class);
            assertThat(application.getBean(AuthRateLimitStore.class)).isInstanceOf(MemoryAuthRateLimitStore.class);
            assertThat(application).doesNotHaveBean(AuthRateLimitFilter.class);
        });
        context.withInitializer(application -> application.getEnvironment().setActiveProfiles("redis"))
            .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class)).run(application -> {
                assertThat(application).hasNotFailed().hasSingleBean(AuthRateLimitStore.class);
                assertThat(application.getBean(AuthRateLimitStore.class)).isInstanceOf(RedisAuthRateLimitStore.class);
            });
    }

    @Test
    void invalidLimitsWindowsCapacityNamespaceAndProxyConfigFailAtStartup() {
        for (String property : new String[] {"login-source-limit=0", "login-pair-limit=-1", "register-source-limit=100001",
                "login-source-window-seconds=0", "login-pair-window-seconds=86401", "register-source-window-seconds=-1",
                "max-buckets=1", "max-buckets=1000001", "namespace=bad{slot}", "trusted-proxy-ips=localhost"}) {
            context.withPropertyValues("app.auth-rate-limit." + property).run(application -> assertThat(application).hasFailed());
        }
    }
}

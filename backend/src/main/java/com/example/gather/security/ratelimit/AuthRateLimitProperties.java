package com.example.gather.security.ratelimit;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Pattern;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;
import java.util.List;

@Validated
@ConfigurationProperties("app.auth-rate-limit")
public record AuthRateLimitProperties(
    @Min(1) @Max(100000) int loginSourceLimit,
    @Min(1) @Max(86400) int loginSourceWindowSeconds,
    @Min(1) @Max(100000) int loginPairLimit,
    @Min(1) @Max(86400) int loginPairWindowSeconds,
    @Min(1) @Max(100000) int registerSourceLimit,
    @Min(1) @Max(86400) int registerSourceWindowSeconds,
    @Min(2) @Max(1000000) int maxBuckets,
    @Pattern(regexp = "[A-Za-z0-9:_-]{1,100}") String namespace,
    List<String> trustedProxyIps
) {
    public AuthRateLimitProperties {
        trustedProxyIps = trustedProxyIps == null ? List.of() : List.copyOf(trustedProxyIps);
        if (trustedProxyIps.stream().anyMatch(value -> ClientSource.canonicalIp(value) == null)) {
            throw new IllegalArgumentException("Trusted proxies must be exact literal IP addresses");
        }
    }
}

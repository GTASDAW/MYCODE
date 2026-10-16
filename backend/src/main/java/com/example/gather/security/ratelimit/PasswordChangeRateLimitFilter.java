package com.example.gather.security.ratelimit;

import com.example.gather.security.AppUserDetails;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Runs after authorization and version validation, before MVC reads the JSON password body. */
public final class PasswordChangeRateLimitFilter extends OncePerRequestFilter {
    private static final PathPatternRequestMatcher PASSWORD = PathPatternRequestMatcher.pathPattern(HttpMethod.POST, "/api/me/password");
    private final AuthRateLimitProperties settings;
    private final AuthRateLimitStore store;
    private final ClientSource sources;
    private final ObjectMapper json;

    public PasswordChangeRateLimitFilter(AuthRateLimitProperties settings, AuthRateLimitStore store, ObjectMapper json) {
        this.settings = settings; this.store = store; this.sources = new ClientSource(settings.trustedProxyIps()); this.json = json;
    }

    @Override protected boolean shouldNotFilter(HttpServletRequest request) { return !PASSWORD.matches(request); }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
        var authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof AppUserDetails principal) || principal.credentialVersion() == null) {
            write(response, 401, Map.of("code", "SESSION_REVOKED", "message", "登录已失效，请重新登录")); return;
        }
        var decision = store.consume(List.of(
            AuthRateLimitFilter.bucket("password-account", Long.toString(principal.id()), "", settings.passwordAccountLimit(), settings.passwordAccountWindowSeconds()),
            AuthRateLimitFilter.bucket("password-source", sources.resolve(request), "", settings.passwordSourceLimit(), settings.passwordSourceWindowSeconds())));
        switch (decision.outcome()) {
            case ALLOWED -> chain.doFilter(request, response);
            case LIMITED -> {
                response.setHeader("Retry-After", Long.toString(decision.retryAfterSeconds()));
                write(response, 429, Map.of("code", "AUTH_RATE_LIMITED", "message", "请求过于频繁，请稍后重试", "retryAfterSeconds", decision.retryAfterSeconds()));
            }
            case UNAVAILABLE -> write(response, 503, Map.of("code", "AUTH_RATE_LIMIT_UNAVAILABLE", "message", "密码修改暂时不可用，请稍后重试"));
        }
    }

    private void write(HttpServletResponse response, int status, Object value) throws IOException {
        response.setStatus(status); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
        json.writeValue(response.getWriter(), value);
    }
}

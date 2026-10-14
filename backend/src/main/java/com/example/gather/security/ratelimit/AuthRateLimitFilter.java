package com.example.gather.security.ratelimit;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Created only inside the SecurityFilterChain, after CSRF and before form authentication. */
public final class AuthRateLimitFilter extends OncePerRequestFilter {
    private static final PathPatternRequestMatcher LOGIN = PathPatternRequestMatcher.pathPattern(HttpMethod.POST, "/api/auth/login");
    private static final PathPatternRequestMatcher REGISTER = PathPatternRequestMatcher.pathPattern(HttpMethod.POST, "/api/auth/register");
    private final AuthRateLimitProperties settings;
    private final AuthRateLimitStore store;
    private final ClientSource sources;
    private final ObjectMapper json;

    public AuthRateLimitFilter(AuthRateLimitProperties settings, AuthRateLimitStore store, ObjectMapper json) {
        this.settings = settings;
        this.store = store;
        this.sources = new ClientSource(settings.trustedProxyIps());
        this.json = json;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !LOGIN.matches(request) && !REGISTER.matches(request);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        String source = sources.resolve(request);
        List<AuthRateLimitStore.Bucket> buckets;
        if (LOGIN.matches(request)) {
            String submitted = request.getParameter("username");
            String username = submitted == null ? "" : submitted.strip().toLowerCase(Locale.ROOT);
            buckets = List.of(
                bucket("login-source", source, "", settings.loginSourceLimit(), settings.loginSourceWindowSeconds()),
                bucket("login-pair", source, username, settings.loginPairLimit(), settings.loginPairWindowSeconds()));
        } else {
            // Do not consume registration JSON here; MVC still validates its original body.
            buckets = List.of(bucket("register-source", source, "", settings.registerSourceLimit(), settings.registerSourceWindowSeconds()));
        }
        AuthRateLimitStore.Decision decision = store.consume(buckets);
        switch (decision.outcome()) {
            case ALLOWED -> chain.doFilter(request, response);
            case LIMITED -> {
                response.setHeader("Retry-After", Long.toString(decision.retryAfterSeconds()));
                write(response, 429, Map.of("code", "AUTH_RATE_LIMITED", "message", "请求过于频繁，请稍后重试",
                    "retryAfterSeconds", decision.retryAfterSeconds()));
            }
            case UNAVAILABLE -> write(response, 503, Map.of("code", "AUTH_RATE_LIMIT_UNAVAILABLE", "message", "登录与注册暂时不可用，请稍后重试"));
        }
    }

    private static AuthRateLimitStore.Bucket bucket(String kind, String source, String username, int limit, int seconds) {
        try {
            MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
            // Length prefixes prevent submitted separators from creating ambiguous identity tuples.
            String identity = kind.length() + ":" + kind + source.length() + ":" + source + username.length() + ":" + username;
            String digest = HexFormat.of().formatHex(sha256.digest(identity.getBytes(StandardCharsets.UTF_8)));
            return new AuthRateLimitStore.Bucket(digest, limit, seconds);
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 unavailable", impossible); }
    }

    private void write(HttpServletResponse response, int status, Object body) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        json.writeValue(response.getWriter(), body);
    }
}

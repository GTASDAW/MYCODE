package com.example.gather.security;

import com.example.gather.api.ApiModels.ErrorView;
import com.example.gather.mapper.CredentialVersionMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Objects;

/** Only in the Security chain, after context/CSRF and before authorization; no hash or version cache. */
public final class CredentialVersionFilter extends OncePerRequestFilter {
    private static final PathPatternRequestMatcher API = PathPatternRequestMatcher.pathPattern("/api/**");
    private static final PathPatternRequestMatcher PUBLIC_ACTIVITIES = PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/activities");
    private static final PathPatternRequestMatcher PUBLIC_ACTIVITY = PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/activities/*");
    private static final PathPatternRequestMatcher PUBLIC_COVER = PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/activities/*/cover");
    private static final PathPatternRequestMatcher PUBLIC_MAP_CONFIG = PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/maps/config");
    private static final PathPatternRequestMatcher PUBLIC_MAP = PathPatternRequestMatcher.pathPattern(HttpMethod.GET, "/api/_AMapService/**");
    private final CredentialVersionMapper versions;
    private final CurrentSessionLogout sessions;
    private final ObjectMapper json;

    public CredentialVersionFilter(CredentialVersionMapper versions, CurrentSessionLogout sessions, ObjectMapper json) {
        this.versions = versions; this.sessions = sessions; this.json = json;
    }

    @Override protected boolean shouldNotFilter(HttpServletRequest request) { return !API.matches(request); }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws IOException, ServletException {
        var authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated() || authentication instanceof AnonymousAuthenticationToken) {
            chain.doFilter(request, response); return;
        }
        if (!(authentication.getPrincipal() instanceof AppUserDetails principal)) {
            try { sessions.logout(request, response, authentication); }
            catch (RuntimeException unavailable) {
                SecurityContextHolder.clearContext(); write(response, 503, "AUTHENTICATION_UNAVAILABLE", "身份验证暂时不可用，请稍后重试"); return;
            }
            write(response, 401, "SESSION_REVOKED", "登录已失效，请重新登录"); return;
        }
        Long current;
        try { current = versions.findByUserId(principal.id()); }
        catch (RuntimeException unavailable) {
            write(response, 503, "AUTHENTICATION_UNAVAILABLE", "身份验证暂时不可用，请稍后重试"); return;
        }
        if (principal.credentialVersion() != null && Objects.equals(principal.credentialVersion(), current)) {
            chain.doFilter(request, response); return;
        }
        try { sessions.logout(request, response, authentication); }
        catch (RuntimeException unavailable) {
            SecurityContextHolder.clearContext();
            write(response, 503, "AUTHENTICATION_UNAVAILABLE", "身份验证暂时不可用，请稍后重试"); return;
        }
        if (PUBLIC_ACTIVITIES.matches(request) || PUBLIC_ACTIVITY.matches(request) || PUBLIC_COVER.matches(request)
            || PUBLIC_MAP_CONFIG.matches(request) || PUBLIC_MAP.matches(request)) chain.doFilter(request, response);
        else write(response, 401, "SESSION_REVOKED", "登录已失效，请重新登录");
    }

    private void write(HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
        json.writeValue(response.getWriter(), new ErrorView(code, message));
    }
}

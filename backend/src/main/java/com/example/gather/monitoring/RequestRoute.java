package com.example.gather.monitoring;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.servlet.HandlerMapping;
import java.util.Set;
import java.util.regex.Pattern;

/** Only this finite vocabulary may enter logs or metric labels; never a raw URL or user-supplied query. */
final class RequestRoute {
    private static final Set<String> METHODS = Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS");
    private static final Set<String> STATIC_ROUTES = Set.of("/api/activities", "/api/activities/search", "/api/auth/csrf", "/api/auth/me",
        "/api/auth/login", "/api/auth/logout", "/api/auth/register", "/api/me/profile", "/api/me/password", "/api/me/avatar", "/api/health", "/api/me/registrations", "/api/me/registrations/search", "/api/admin/overview",
        "/api/admin/activities", "/api/admin/audit-logs", "/api/admin/attendance", "/api/admin/monitoring", "/api/me/notifications", "/api/me/notifications/unread-count", "/api/me/notifications/read-all", "/api/me/favorites");
    private static final Set<String> VARIABLE_ROUTES = Set.of("/api/activities/{id}",
        "/api/activities/{id}/cover", "/api/admin/activities/{id}/cover",
        "/api/activities/{id}/registration", "/api/admin/activities/{id}/registrations",
        "/api/admin/activities/{id}/registrations/export", "/api/admin/activities/{id}/registrations/{registrationId}/check-in",
        "/api/admin/activities/{id}", "/api/admin/activities/{id}/cancel", "/api/admin/audit-logs/{id}", "/api/me/notifications/{id}/read", "/api/me/favorites/{activityId}");
    private static final Pattern DETAIL = Pattern.compile("/api/activities/[^/;]+/?");
    private static final Pattern COVER = Pattern.compile("/api/activities/[^/;]+/cover/?");
    private static final Pattern ADMIN_COVER = Pattern.compile("/api/admin/activities/[^/;]+/cover/?");
    private static final Pattern REGISTRATION = Pattern.compile("/api/activities/[^/;]+/registration/?");
    private static final Pattern ROSTER = Pattern.compile("/api/admin/activities/[^/;]+/registrations/?");
    private static final Pattern ROSTER_EXPORT = Pattern.compile("/api/admin/activities/[^/;]+/registrations/export/?");
    private static final Pattern CHECK_IN = Pattern.compile("/api/admin/activities/[^/;]+/registrations/[^/;]+/check-in/?");
    private static final Pattern ADMIN_ACTIVITY = Pattern.compile("/api/admin/activities/[^/;]+/?");
    private static final Pattern ADMIN_CANCEL = Pattern.compile("/api/admin/activities/[^/;]+/cancel/?");
    private static final Pattern NOTIFICATION_READ = Pattern.compile("/api/me/notifications/[^/;]+/read/?");
    private static final Pattern AUDIT_DETAIL = Pattern.compile("/api/admin/audit-logs/[^/;]+/?");
    private static final Pattern FAVORITE = Pattern.compile("/api/me/favorites/[^/;]+/?");

    private RequestRoute() {}

    static String method(String method) { return METHODS.contains(method) ? method : "OTHER"; }

    static String path(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String context = request.getContextPath();
        return context.isEmpty() ? uri : uri.substring(context.length());
    }

    static boolean isApi(HttpServletRequest request) {
        String path = path(request);
        return path.equals("/api") || path.startsWith("/api/");
    }

    static String resolve(HttpServletRequest request) {
        Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (pattern instanceof String route && (STATIC_ROUTES.contains(route) || VARIABLE_ROUTES.contains(route))) {
            return route;
        }
        // Security and Session filters can answer before MVC has identified a handler.
        String path = path(request);
        if (STATIC_ROUTES.contains(path)) return path;
        if (COVER.matcher(path).matches()) return "/api/activities/{id}/cover";
        if (ADMIN_COVER.matcher(path).matches()) return "/api/admin/activities/{id}/cover";
        if (FAVORITE.matcher(path).matches()) return "/api/me/favorites/{activityId}";
        if (AUDIT_DETAIL.matcher(path).matches()) return "/api/admin/audit-logs/{id}";
        if (NOTIFICATION_READ.matcher(path).matches()) return "/api/me/notifications/{id}/read";
        if (REGISTRATION.matcher(path).matches()) return "/api/activities/{id}/registration";
        if (ROSTER.matcher(path).matches()) return "/api/admin/activities/{id}/registrations";
        if (ROSTER_EXPORT.matcher(path).matches()) return "/api/admin/activities/{id}/registrations/export";
        if (CHECK_IN.matcher(path).matches()) return "/api/admin/activities/{id}/registrations/{registrationId}/check-in";
        if (ADMIN_CANCEL.matcher(path).matches()) return "/api/admin/activities/{id}/cancel";
        if (ADMIN_ACTIVITY.matcher(path).matches()) return "/api/admin/activities/{id}";
        if (DETAIL.matcher(path).matches()) return "/api/activities/{id}";
        return "/UNKNOWN";
    }

    static boolean measured(String route) {
        return !route.equals("/api/health") && !route.equals("/api/admin/monitoring");
    }
}

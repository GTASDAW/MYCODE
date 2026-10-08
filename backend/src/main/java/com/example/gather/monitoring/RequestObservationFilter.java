package com.example.gather.monitoring;

import com.example.gather.api.ApiModels.ErrorView;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.session.web.http.SessionRepositoryFilter;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.UUID;

@Component
@Order(SessionRepositoryFilter.DEFAULT_ORDER - 1)
public class RequestObservationFilter extends OncePerRequestFilter {
    public static final String REQUEST_ID_ATTRIBUTE = RequestObservationFilter.class.getName() + ".requestId";
    public static final String EXCEPTION_ATTRIBUTE = RequestObservationFilter.class.getName() + ".exceptionType";
    public static final String HEADER = "X-Request-Id";
    private static final Logger log = LoggerFactory.getLogger(RequestObservationFilter.class);
    private final MonitoringService monitoring;
    private final ObjectMapper json;

    public RequestObservationFilter(MonitoringService monitoring, ObjectMapper json) {
        this.monitoring = monitoring;
        this.json = json;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) { return !RequestRoute.isApi(request); }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId = UUID.randomUUID().toString();
        String previous = MDC.get("requestId");
        request.setAttribute(REQUEST_ID_ATTRIBUTE, requestId);
        response.setHeader(HEADER, requestId);
        MDC.put("requestId", requestId);
        long started = System.nanoTime();
        boolean failed = false;
        try {
            chain.doFilter(request, response);
        } catch (ServletException | IOException | RuntimeException exception) {
            failed = true;
            request.setAttribute(EXCEPTION_ATTRIBUTE, exception.getClass().getName());
            // Never pass the Throwable to the logger: Redis/JDBC messages may contain credentials or user input.
            var event = log.atError().addKeyValue("event", "api_failure")
                .addKeyValue("exceptionType", exception.getClass().getName());
            if (exception.getStackTrace().length > 0) event.addKeyValue("frame", exception.getStackTrace()[0].toString());
            event.log("API filter failed");
            if (exception instanceof RuntimeException && !response.isCommitted() && !request.isAsyncStarted()) {
                // Session failures occur outside MVC advice. Return the same safe JSON contract before /error dispatch.
                response.resetBuffer();
                response.setHeader(HEADER, requestId);
                response.setStatus(500);
                response.setContentType("application/json");
                response.setCharacterEncoding("UTF-8");
                json.writeValue(response.getWriter(), new ErrorView("INTERNAL_ERROR", "服务暂时不可用，请稍后重试"));
                return;
            }
            throw exception;
        } finally {
            try {
                long duration = Math.max(0, System.nanoTime() - started);
                String route = RequestRoute.resolve(request);
                String method = RequestRoute.method(request.getMethod());
                int status = failed || response.getStatus() < 100 || response.getStatus() > 599 ? 500 : response.getStatus();
                monitoring.recordRequest(method, route, status, duration);
                // Boot's structured formatter includes requestId from MDC; adding it twice rejects the whole event.
                var event = log.atInfo().addKeyValue("event", "http_request")
                    .addKeyValue("method", method).addKeyValue("route", route).addKeyValue("status", status)
                    .addKeyValue("durationMs", duration / 1_000_000.0);
                Object exceptionType = request.getAttribute(EXCEPTION_ATTRIBUTE);
                if (exceptionType instanceof String type) event.addKeyValue("exceptionType", type);
                event.log("API request completed");
            } finally {
                if (previous == null) MDC.remove("requestId"); else MDC.put("requestId", previous);
            }
        }
    }
}

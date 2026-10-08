package com.example.gather.monitoring;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.ObjectMapper;
import javax.sql.DataSource;
import java.util.UUID;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.mock;

class RequestObservationFilterTest {
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private final MonitoringService monitoring = new MonitoringService(registry, mock(DataSource.class), "filter-test");
    private final ObjectMapper json = new ObjectMapper();
    private final RequestObservationFilter filter = new RequestObservationFilter(monitoring, json);

    @AfterEach
    void cleanup() {
        MDC.remove("requestId");
        registry.close();
    }

    @Test
    void preMvcSessionFailureReturnsSafeJson500AndRequestIdWithoutLeakingCause() throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/auth/me");
        request.addHeader("X-Request-Id", "untrusted-id");
        var response = new MockHttpServletResponse();
        var logger = (Logger) LoggerFactory.getLogger(RequestObservationFilter.class);
        var appender = new ListAppender<ILoggingEvent>() {
            @Override
            protected void append(ILoggingEvent event) {
                event.prepareForDeferredProcessing();
                super.append(event);
            }
        };
        appender.start();
        logger.addAppender(appender);
        MDC.put("requestId", "outer-context");
        try {
            filter.doFilter(request, response, (req, res) -> {
                throw new IllegalStateException("TEST_PRIVATE_SESSION_MESSAGE", new IllegalArgumentException("TEST_PRIVATE_CAUSE"));
            });
            assertThat(response.getStatus()).isEqualTo(500);
            assertThat(response.getContentType()).startsWith("application/json");
            assertThat(json.readTree(response.getContentAsString()).get("code").asString()).isEqualTo("INTERNAL_ERROR");
            assertThat(json.readTree(response.getContentAsString()).get("message").asString()).isEqualTo("服务暂时不可用，请稍后重试");
            String id = response.getHeader("X-Request-Id");
            assertThat(UUID.fromString(id).toString()).isEqualTo(id);
            assertThat(request.getAttribute(RequestObservationFilter.REQUEST_ID_ATTRIBUTE)).isEqualTo(id);
            assertThat(MDC.get("requestId")).isEqualTo("outer-context");
            assertThat(appender.list).hasSize(2).allSatisfy(event -> {
                assertThat(event.getThrowableProxy()).isNull();
                assertThat(event.getFormattedMessage()).doesNotContain("TEST_PRIVATE");
                assertThat(event.getKeyValuePairs().toString()).doesNotContain("TEST_PRIVATE");
                assertThat(event.getMDCPropertyMap().get("requestId")).isEqualTo(id);
            });
            assertThat(monitoring.snapshot().serverErrors()).isEqualTo(1);
            assertThat(monitoring.snapshot().routes().getFirst().route()).isEqualTo("/api/auth/me");
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void committedOrAsyncResponsesAreNotOverwrittenAndMdcIsStillCleared() throws Exception {
        var committedRequest = new MockHttpServletRequest("GET", "/api/activities");
        var committed = new MockHttpServletResponse();
        assertThatThrownBy(() -> filter.doFilter(committedRequest, committed, (req, res) -> {
            res.getWriter().write("existing-content");
            res.flushBuffer();
            throw new IllegalStateException("private-failure");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(committed.getContentAsString()).isEqualTo("existing-content");
        assertThat(committed.getStatus()).isEqualTo(200);
        assertThat(MDC.get("requestId")).isNull();

        var asyncRequest = new MockHttpServletRequest("GET", "/api/activities");
        asyncRequest.setAsyncSupported(true);
        var asyncResponse = new MockHttpServletResponse();
        assertThatThrownBy(() -> filter.doFilter(asyncRequest, asyncResponse, (req, res) -> {
            req.startAsync();
            throw new IllegalStateException("private-failure");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(asyncResponse.getContentAsString()).isEmpty();
        assertThat(MDC.get("requestId")).isNull();
        asyncRequest.getAsyncContext().complete();
    }
}

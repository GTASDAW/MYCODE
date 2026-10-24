package com.example.gather.monitoring;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.HandlerMapping;
import java.util.List;
import static org.assertj.core.api.Assertions.*;

class MapRequestRouteTest {
    @Test void mapLogsAndMetricsUseOnlyFiniteRoutesWithoutQueryValuesBeforeOrAfterMvc() {
        for (String path : List.of("/api/maps/config", "/api/_AMapService/v3/place/text", "/api/_AMapService/v3/assistant/inputtips",
            "/api/_AMapService/v3/geocode/regeo", "/api/_AMapService/v4/map/styles")) {
            var request = new MockHttpServletRequest("GET", path);
            request.setQueryString("key=PRIVATE_KEY&jscode=PRIVATE_CODE&keywords=PRIVATE_SEARCH");
            assertThat(RequestRoute.resolve(request)).isEqualTo(path);
            request.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, path);
            assertThat(RequestRoute.resolve(request)).isEqualTo(path).doesNotContain("PRIVATE");
        }
        var unknown = new MockHttpServletRequest("GET", "/api/_AMapService/PRIVATE_UNKNOWN");
        assertThat(RequestRoute.resolve(unknown)).isEqualTo("/UNKNOWN");
    }
}

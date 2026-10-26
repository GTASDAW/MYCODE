package com.example.gather.monitoring;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.HandlerMapping;
import static org.assertj.core.api.Assertions.*;

class LocationCheckInRouteTest {
    @Test void bothLocationEncodingsHaveSeparateFiniteRoutesBeforeAndAfterMvc(){
        for(String suffix:new String[]{"","/gcj02"}){
            String template="/api/me/registrations/{registrationId}/check-in"+suffix;
            var request=new MockHttpServletRequest("POST","/api/me/registrations/987654321/check-in"+suffix);
            request.setQueryString("private=NEVER_LOG_COORDINATES");
            assertThat(RequestRoute.resolve(request)).isEqualTo(template);
            request.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE,template);
            assertThat(RequestRoute.resolve(request)).isEqualTo(template).doesNotContain("987654321","NEVER_LOG");
        }
        assertThat(RequestRoute.resolve(new MockHttpServletRequest("POST","/api/me/registrations/1/check-in/guessed"))).isEqualTo("/UNKNOWN");
    }
}

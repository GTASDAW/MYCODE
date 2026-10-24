package com.example.gather.api;

import com.example.gather.api.ApiModels.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.time.Instant;
import static org.assertj.core.api.Assertions.*;

class LocationPointTest {
    final ObjectMapper json = new ObjectMapper();

    @Test void normalizesHalfUpOnlyAfterValidatingOriginalRangeAndRequiresACompletePair() {
        assertThat(new LocationPoint(new BigDecimal("116.39742845"), new BigDecimal("-39.90923445")))
            .isEqualTo(new LocationPoint(new BigDecimal("116.3974285"), new BigDecimal("-39.9092345")));
        for (var pair : new BigDecimal[][] {{null, BigDecimal.ZERO}, {BigDecimal.ZERO, null},
            {new BigDecimal("180.00000001"), BigDecimal.ZERO}, {new BigDecimal("-180.00000001"), BigDecimal.ZERO},
            {BigDecimal.ZERO, new BigDecimal("90.00000001")}, {BigDecimal.ZERO, new BigDecimal("-90.00000001")}})
            assertThatThrownBy(() -> new LocationPoint(pair[0], pair[1])).isInstanceOf(ApiException.class);
        assertThat(new LocationPoint(new BigDecimal("180"), new BigDecimal("90")).longitude()).isEqualTo(new BigDecimal("180.0000000"));
    }

    @Test void jsonEditDistinguishesAbsentExplicitNullAndAReplacementWhileRetainingOldConstructors() {
        String base = "\"title\":\"活动\",\"description\":\"介绍\",\"location\":\"会场\"";
        var absent = json.readValue("{" + base + "}", EditActivityRequest.class);
        assertThat(absent.title()).isEqualTo("活动"); assertThat(absent.locationPointSpecified()).isFalse();
        var cleared = json.readValue("{" + base + ",\"locationPoint\":null}", EditActivityRequest.class);
        assertThat(cleared.locationPointSpecified()).isTrue(); assertThat(cleared.locationPoint()).isNull();
        var set = json.readValue("{" + base + ",\"locationPoint\":{\"longitude\":116.1,\"latitude\":39.2}}", EditActivityRequest.class);
        assertThat(set.locationPointSpecified()).isTrue();
        assertThat(set.locationPoint().latitude()).isEqualByComparingTo("39.2");
        assertThat(new EditActivityRequest("title", "description", "location").locationPointSpecified()).isFalse();
        assertThat(new CreateActivityRequest("t", "d", "l", Instant.now(), 2).locationPoint()).isNull();
    }

    @Test void jsonRejectsPartialOrOutOfRangeCoordinatesAndSerializesNumbers() {
        for (String point : new String[] {"{}", "{\"longitude\":1}", "{\"longitude\":null,\"latitude\":1}",
            "{\"longitude\":180.00000001,\"latitude\":1}", "{\"longitude\":\"NaN\",\"latitude\":1}"})
            assertThatThrownBy(() -> json.readValue(point, LocationPoint.class)).isInstanceOf(RuntimeException.class);
        var encoded = json.readTree(json.writeValueAsString(new LocationPoint(new BigDecimal("116.1"), new BigDecimal("39.2"))));
        assertThat(encoded.get("longitude").isNumber()).isTrue(); assertThat(encoded.get("latitude").isNumber()).isTrue();
    }
}

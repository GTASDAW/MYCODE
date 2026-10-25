package com.example.gather.maps;

import com.example.gather.api.ApiException;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.ArrayList;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;

class LocationCoordinateConverterTest {
    private static final String WEB_KEY = "offline_web_key_1234567890";
    private final ObjectMapper json = new ObjectMapper();
    @Test void fixedSinglePointGpsProtocolUsesOnlyIndependentBackendWebKey() {
        var seen = new AtomicReference<URI>();
        var converter = service(WEB_KEY, uri -> { seen.set(uri); return response("{\"status\":\"1\",\"locations\":\"116.4031234,39.9101234\"}"); });
        assertThat(converter.convert(new BigDecimal("116.3971234"), new BigDecimal("39.9081234")))
            .isEqualTo(new LocationCoordinateConverter.Point(new BigDecimal("116.4031234"), new BigDecimal("39.9101234")));
        assertThat(seen.get().getScheme()).isEqualTo("https");
        assertThat(seen.get().getHost()).isEqualTo("restapi.amap.com");
        assertThat(seen.get().getPath()).isEqualTo("/v3/assistant/coordinate/convert");
        assertThat(seen.get().getRawQuery()).isEqualTo("coordsys=gps&output=JSON&locations=116.3971234,39.9081234&key=" + WEB_KEY);
    }
    @Test void missingOrInvalidKeyDisablesWithoutCallingTransportAndDoesNotBecomeBrowserConfiguration() {
        var calls = new AtomicInteger();
        for (String key : List.of("", "short", "bad_key_1234567890\n")) {
            var configuration = new LocationCheckInConfiguration(key);
            assertThat(configuration.enabled()).isFalse();
            var converter = service(key, uri -> { calls.incrementAndGet(); return response("{}"); });
            assertUnavailable(converter);
        }
        assertThat(calls).hasValue(0);
        assertThat(json.writeValueAsString(new MapConfiguration("", "").view())).doesNotContain(WEB_KEY, "webServiceKey");
    }
    @Test void rejectsFailedRedirectOversizedMalformedMultiPointAndOutOfRangeResponses() {
        for (AmapTransport.Response response : List.of(new AmapTransport.Response(302,"application/json",new byte[0]),
            new AmapTransport.Response(200,"text/html","{}".getBytes(StandardCharsets.UTF_8)),
            new AmapTransport.Response(200,"application/json",new byte[AmapTransport.MAX_RESPONSE_BYTES+1]),
            response("{\"status\":\"0\",\"info\":\"INVALID_USER_KEY\"}"), response("{broken"),
            response("{\"status\":\"1\",\"locations\":\"1,2;3,4\"}"),
            response("{\"status\":\"1\",\"locations\":\"181,0\"}"),
            response("{\"status\":\"1\",\"locations\":\"0,-91\"}"),
            response("{\"status\":\"1\",\"locations\":\"NaN,0\"}"),
            response("{\"status\":\"1\",\"locations\":[1,2]}"))) assertUnavailable(service(WEB_KEY, uri -> response));
        assertUnavailable(service(WEB_KEY, uri -> { throw new java.io.IOException("sensitive URI " + uri); }));
    }
    @Test void refusesConversionInsideAnyDatabaseTransaction() {
        var calls = new AtomicInteger();
        var converter = service(WEB_KEY, uri -> { calls.incrementAndGet(); return success(); });
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            for (int attempt = 0; attempt < 32; attempt++)
                assertThatThrownBy(() -> converter.convert(BigDecimal.ZERO, BigDecimal.ZERO)).isInstanceOf(IllegalStateException.class);
        } finally { TransactionSynchronizationManager.setActualTransactionActive(false); }
        assertThat(calls).hasValue(0);
        assertThat(converter.convert(BigDecimal.ZERO, BigDecimal.ZERO).longitude()).isEqualByComparingTo("116.4031234");
        assertThat(calls).hasValue(1);
    }
    @Test void admitsSixteenInFlightRejectsTheNextWithoutTransportAndRestoresFullCapacity() throws Exception {
        var calls = new AtomicInteger();
        var entered = new AtomicReference<CountDownLatch>();
        var release = new AtomicReference<CountDownLatch>();
        var converter = service(WEB_KEY, uri -> {
            calls.incrementAndGet(); entered.get().countDown();
            if (!release.get().await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out waiting for contract response");
            return success();
        });
        var pool = Executors.newFixedThreadPool(16);
        try {
            for (int round = 0; round < 2; round++) {
                entered.set(new CountDownLatch(16)); release.set(new CountDownLatch(1));
                var pending = new ArrayList<Future<LocationCoordinateConverter.Point>>();
                for (int index = 0; index < 16; index++) pending.add(pool.submit(() -> converter.convert(BigDecimal.ZERO, BigDecimal.ZERO)));
                try {
                    assertThat(entered.get().await(10, TimeUnit.SECONDS)).isTrue();
                    int dispatched = calls.get();
                    assertUnavailable(converter);
                    assertThat(calls).hasValue(dispatched);
                } finally { release.get().countDown(); }
                for (var request : pending) assertThat(request.get(10, TimeUnit.SECONDS).latitude()).isEqualByComparingTo("39.9101234");
            }
            assertThat(calls).hasValue(32);
        } finally {
            if (release.get() != null) release.get().countDown();
            pool.shutdownNow(); assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
        }
    }
    @Test void providerTransportAndParsingFailuresAlwaysReleaseTheirPermit() {
        var calls = new AtomicInteger();
        var converter = service(WEB_KEY, uri -> {
            int sequence = calls.getAndIncrement();
            return switch (sequence % 4) {
                case 0 -> throw new java.io.IOException("Sensitive upstream request");
                case 1 -> response("{broken");
                case 2 -> response("{\"status\":\"0\"}");
                default -> new AmapTransport.Response(302, "application/json", new byte[0]);
            };
        });
        for (int attempt = 0; attempt < 64; attempt++) assertUnavailable(converter);
        assertThat(calls).hasValue(64);
    }
    @Test void interruptionRestoresInterruptFlagAndReleasesCapacity() {
        var calls = new AtomicInteger();
        var converter = service(WEB_KEY, uri -> { calls.incrementAndGet(); throw new InterruptedException("Interrupted contract response"); });
        for (int attempt = 0; attempt < 32; attempt++) {
            try {
                assertUnavailable(converter);
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
            } finally { Thread.interrupted(); }
        }
        assertThat(calls).hasValue(32);
    }
    private void assertUnavailable(LocationCoordinateConverter converter) {
        assertThatThrownBy(() -> converter.convert(new BigDecimal("116.3971234"), new BigDecimal("39.9081234")))
            .isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.status().value()).isEqualTo(503); assertThat(error.code()).isEqualTo("LOCATION_CHECK_IN_UNAVAILABLE");
                assertThat(error.getMessage()).doesNotContain(WEB_KEY, "116.3971234", "39.9081234");
                assertThat(error.getCause()).isNull();
            });
    }
    private LocationCoordinateConverter service(String key, AmapTransport transport) { return new LocationCoordinateConverter(new LocationCheckInConfiguration(key), transport, json); }
    private static AmapTransport.Response success() { return response("{\"status\":\"1\",\"locations\":\"116.4031234,39.9101234\"}"); }
    private static AmapTransport.Response response(String body) { return new AmapTransport.Response(200,"application/json;charset=UTF-8",body.getBytes(StandardCharsets.UTF_8)); }
}

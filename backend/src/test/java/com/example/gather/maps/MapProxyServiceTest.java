package com.example.gather.maps;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiExceptionHandler;
import com.example.gather.api.MapController;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Provider contract replacements: these do not establish an authenticated real AMap integration. */
class MapProxyServiceTest {
    static final String KEY = "a".repeat(32), SECRET = "b".repeat(32);
    final MapConfiguration enabled = new MapConfiguration(KEY, SECRET);
    final ObjectMapper json = new ObjectMapper();

    @Test void configurationRequiresBothValidValuesAndNeverPublishesTheSecurityCode() throws Exception {
        for (var config : List.of(new MapConfiguration("", ""), new MapConfiguration(KEY, ""),
            new MapConfiguration("", SECRET), new MapConfiguration("<script>bad key</script>", SECRET),
            new MapConfiguration(KEY, SECRET + "\n"))) {
            assertThat(config.view()).isEqualTo(new MapConfiguration.View(false, null, "/api/_AMapService"));
            var calls = new AtomicInteger();
            var proxy = service(config, uri -> { calls.incrementAndGet(); return response("{}"); });
            assertFailure(() -> proxy.get("/v3/place/text", query("keywords", "会场"), 10), HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(calls).hasValue(0);
        }
        assertThat(json.writeValueAsString(enabled.view())).contains(KEY).doesNotContain(SECRET, "securityCode");
        var mvc = MockMvcBuilders.standaloneSetup(new MapController(enabled, service(enabled, uri -> response("{}"))))
            .setControllerAdvice(new ApiExceptionHandler()).build();
        mvc.perform(get("/api/maps/config")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.enabled").value(true)).andExpect(jsonPath("$.jsKey").value(KEY))
            .andExpect(jsonPath("$.serviceHost").value("/api/_AMapService")).andExpect(jsonPath("$.securityCode").doesNotExist());
    }

    @Test void allowlistedRoutesChooseFixedHttpsHostsAndReplaceOnlyTheLocalKey() {
        var observed = new AtomicReference<URI>();
        var proxy = service(enabled, uri -> { observed.set(uri); return response("{\"status\":\"1\"}"); });
        for (String path : List.of("/v3/place/text", "/v3/assistant/inputtips", "/v3/geocode/regeo", "/v4/map/styles")) {
            var parameters = query("keywords", "北京 会场&safe=true"); parameters.add("key", "attacker-key");
            assertThat(proxy.get(path, parameters, 40).contentType()).isEqualTo("application/json;charset=UTF-8");
            assertThat(observed.get().getScheme()).isEqualTo("https");
            assertThat(observed.get().getHost()).isEqualTo(path.startsWith("/v4") ? "webapi.amap.com" : "restapi.amap.com");
            assertThat(observed.get().getRawPath()).isEqualTo(path);
            assertThat(observed.get().getRawQuery()).contains("key=" + KEY, "jscode=" + SECRET, "%26safe%3Dtrue")
                .doesNotContain("attacker-key");
        }
        for (String path : List.of("/v3/place/around", "//evil.test/", "/v3/place/text/../other"))
            assertFailure(() -> proxy.get(path, query("keywords", "x"), 10), HttpStatus.NOT_FOUND);
    }

    @Test void boundedQueriesRejectCredentialInjectionArbitraryTargetsAndExecutableCallbacksBeforeTransport() {
        var calls = new AtomicInteger();
        var proxy = service(enabled, uri -> { calls.incrementAndGet(); return response("{}"); });
        for (var input : List.of(query("jscode", "caller-secret"), query("url", "http://evil.test"), query("host", "evil.test"),
            query("keywords", "x".repeat(2049)), query("keywords", "line\nbreak"), query("callback", "alert(1)"),
            query("callback", "x);window.alert(1);//"), query("output", "XML")))
            assertFailure(() -> proxy.get("/v3/place/text", input, 10), HttpStatus.BAD_REQUEST);
        var duplicate = query("keywords", "first"); duplicate.add("keywords", "second");
        assertFailure(() -> proxy.get("/v3/place/text", duplicate, 10), HttpStatus.BAD_REQUEST);
        assertFailure(() -> proxy.get("/v3/place/text", query("keywords", "safe"), 8193), HttpStatus.BAD_REQUEST);
        assertThat(calls).hasValue(0);
    }

    @Test void providerJsonpIsReturnedOnlyWithTheValidatedRequestedCallbackAndValidJsonPayload() {
        var proxy = service(enabled, uri -> new AmapTransport.Response(200, "text/javascript;charset=UTF-8", bytes("AMap._cb_1({\"tips\":[]});")));
        assertThat(proxy.get("/v3/assistant/inputtips", query("callback", "AMap._cb_1"), 20).contentType())
            .isEqualTo("application/javascript;charset=UTF-8");
        for (String body : List.of("other({});", "AMap._cb_1({});alert(1)", "AMap._cb_1(window.alert(1));", "<html>error</html>",
            "AMap._cb_1({});alert(1);AMap._cb_1({});")) {
            var invalid = service(enabled, uri -> new AmapTransport.Response(200, "text/javascript", bytes(body)));
            assertFailure(() -> invalid.get("/v3/assistant/inputtips", query("callback", "AMap._cb_1"), 20), HttpStatus.BAD_GATEWAY);
        }
    }

    @Test void rejectsRedirectsHtmlOversizeMalformedUtf8AndReflectedSecretsWithoutPublishingRawFailures() {
        for (var response : List.of(new AmapTransport.Response(302, "application/json", bytes("{}")),
            new AmapTransport.Response(200, "text/html", bytes("{}")),
            new AmapTransport.Response(200, "application/json", new byte[AmapTransport.MAX_RESPONSE_BYTES + 1]),
            new AmapTransport.Response(200, "application/json", new byte[] {(byte) 0xc3, (byte) 0x28}),
            response("{\"error\":\"" + SECRET + "\"}"))) {
            var proxy = service(enabled, uri -> response);
            assertFailure(() -> proxy.get("/v3/place/text", query("keywords", "会场"), 10), HttpStatus.BAD_GATEWAY);
        }
        var failed = service(enabled, uri -> { throw new IllegalStateException("secret=" + SECRET + "&keywords=private"); });
        assertThatThrownBy(() -> failed.get("/v3/place/text", query("keywords", "private"), 10))
            .isInstanceOf(ApiException.class).hasNoCause().hasMessageNotContaining(SECRET).hasMessageNotContaining("private");
    }

    @Test void controllerDoesNotAcceptRequestBodiesAndSetsSafeResponseHeaders() throws Exception {
        var calls = new AtomicInteger();
        var mvc = MockMvcBuilders.standaloneSetup(new MapController(enabled, service(enabled, uri -> {
            calls.incrementAndGet(); return response("{\"status\":\"1\"}");
        }))).setControllerAdvice(new ApiExceptionHandler()).build();
        mvc.perform(get("/api/_AMapService/v3/place/text").param("keywords", "会场").header("Cookie", "secret-cookie")
            .header("Authorization", "secret-authorization")).andExpect(status().isOk())
            .andExpect(header().string("Cache-Control", "no-store")).andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andExpect(content().json("{\"status\":\"1\"}"));
        mvc.perform(get("/api/_AMapService/v3/place/text").content("body")).andExpect(status().isBadRequest());
        assertThat(calls).hasValue(1);
    }

    @Test void concurrentTransportIsCappedAndCapacityIsReleasedAfterFailure() throws Exception {
        var entered = new CountDownLatch(16); var release = new CountDownLatch(1);
        var proxy = service(enabled, uri -> { entered.countDown(); release.await(5, TimeUnit.SECONDS); throw new IllegalStateException("test failure"); });
        try (var workers = Executors.newFixedThreadPool(16)) {
            var requests = new java.util.ArrayList<Future<?>>();
            for (int i = 0; i < 16; i++) requests.add(workers.submit(() -> assertFailure(
                () -> proxy.get("/v3/place/text", query("keywords", "x"), 1), HttpStatus.BAD_GATEWAY)));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                assertFailure(() -> proxy.get("/v3/place/text", query("keywords", "x"), 1), HttpStatus.SERVICE_UNAVAILABLE);
            } finally { release.countDown(); }
            for (var request : requests) request.get(5, TimeUnit.SECONDS);
            assertFailure(() -> proxy.get("/v3/place/text", query("keywords", "x"), 1), HttpStatus.BAD_GATEWAY);
        }
    }

    @Test void streamingBodyStopsAtTwoMibBeforeAccumulatingAnOversizeResponse() {
        var subscriber = new HttpAmapTransport.LimitedBody(); var cancelled = new AtomicInteger();
        subscriber.onSubscribe(new Flow.Subscription() {
            @Override public void request(long count) {}
            @Override public void cancel() { cancelled.incrementAndGet(); }
        });
        subscriber.onNext(List.of(ByteBuffer.wrap(new byte[AmapTransport.MAX_RESPONSE_BYTES])));
        subscriber.onNext(List.of(ByteBuffer.wrap(new byte[1])));
        assertThat(cancelled).hasValue(1);
        assertThat(subscriber.getBody().toCompletableFuture()).isCompletedExceptionally();
    }

    private MapProxyService service(MapConfiguration config, AmapTransport transport) { return new MapProxyService(config, transport, json); }
    private static LinkedMultiValueMap<String, String> query(String key, String value) {
        var result = new LinkedMultiValueMap<String, String>(); result.add(key, value); return result;
    }
    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static AmapTransport.Response response(String body) { return new AmapTransport.Response(200, "application/json", bytes(body)); }
    private static void assertFailure(Runnable action, HttpStatus status) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class, failure -> assertThat(failure.status()).isEqualTo(status));
    }
}

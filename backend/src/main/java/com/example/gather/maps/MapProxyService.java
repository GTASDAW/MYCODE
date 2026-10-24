package com.example.gather.maps;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.MultiValueMap;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.DeserializationFeature;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;

@Service
public final class MapProxyService {
    private static final Map<String, String> UPSTREAMS = Map.of(
        "/v3/place/text", "https://restapi.amap.com/v3/place/text",
        "/v3/assistant/inputtips", "https://restapi.amap.com/v3/assistant/inputtips",
        "/v3/geocode/regeo", "https://restapi.amap.com/v3/geocode/regeo",
        "/v4/map/styles", "https://webapi.amap.com/v4/map/styles");
    private static final Set<String> PARAMETERS = Set.of("keywords", "city", "citylimit", "types", "offset", "page",
        "extensions", "location", "radius", "poitype", "roadlevel", "batch", "callback", "output", "datatype",
        "platform", "appname", "logversion", "sdkversion", "s", "csid", "children", "language", "type_", "antiCrab",
        "_", "id", "styleid", "ispublic", "key");
    private static final Pattern CALLBACK = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*){0,5}");
    private final MapConfiguration configuration;
    private final AmapTransport transport;
    private final ObjectMapper json;
    private final Semaphore inFlight = new Semaphore(16);

    public MapProxyService(MapConfiguration configuration, AmapTransport transport, ObjectMapper json) {
        this.configuration = configuration; this.transport = transport; this.json = json;
    }

    public Result get(String path, MultiValueMap<String, String> parameters, int rawQueryLength) {
        String base = UPSTREAMS.get(path);
        if (base == null) throw new ApiException(HttpStatus.NOT_FOUND, "MAP_ROUTE_NOT_FOUND", "地图接口不存在");
        if (!configuration.enabled()) throw unavailable();
        if (rawQueryLength > 8192 || parameters.size() > 32) throw invalid();
        var query = new StringBuilder();
        for (var entry : parameters.entrySet()) {
            String name = entry.getKey();
            var values = entry.getValue();
            if (!PARAMETERS.contains(name) || values.isEmpty() || values.size() > (name.equals("s") || name.equals("key") ? 2 : 1)) throw invalid();
            // JSAPI can repeat matching SDK markers or keys; preserve markers and replace every caller key below.
            if (values.size() == 2 && !java.util.Objects.equals(values.getFirst(), values.getLast())) throw invalid();
            for (String value : values) {
                if (value == null || value.length() > 2048 || value.chars().anyMatch(Character::isISOControl)) throw invalid();
                if (name.equals("key")) continue; // Always replace a caller's key with the locally configured JS key.
                if (name.equals("callback") && (value.length() > 128 || !CALLBACK.matcher(value).matches())) throw invalid();
                if (name.equals("output") && !value.equalsIgnoreCase("JSON")) throw invalid();
                append(query, name, value);
                if (query.length() > 8192) throw invalid();
            }
        }
        append(query, "key", configuration.jsKey());
        append(query, "jscode", configuration.securityCode());
        if (query.length() > 8192) throw invalid();
        if (!inFlight.tryAcquire()) throw unavailable();
        try {
            var response = transport.get(URI.create(base + "?" + query));
            if (response.status() != 200 || response.body() == null || response.body().length > AmapTransport.MAX_RESPONSE_BYTES) throw upstream();
            String body = decode(response.body());
            // Never return an upstream reflection of the server-only security code.
            if (body.contains(configuration.securityCode())) throw upstream();
            String content = body.strip();
            String callback = parameters.getFirst("callback");
            boolean jsonp = callback != null && content.startsWith(callback + "(") && (content.endsWith(");") || content.endsWith(")"));
            String payload = jsonp ? content.substring(callback.length() + 1, content.endsWith(";") ? content.length() - 2 : content.length() - 1).strip() : content;
            var parsed = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
            if (parsed == null || !parsed.isObject() && !parsed.isArray()) throw upstream();
            if (json.writeValueAsString(parsed).contains(configuration.securityCode())) throw upstream();
            String type = response.contentType() == null ? "" : response.contentType().split(";", 2)[0].strip().toLowerCase(java.util.Locale.ROOT);
            if (jsonp && !Set.of("application/javascript", "text/javascript", "application/json").contains(type)
                || !jsonp && !Set.of("application/json", "text/json", "text/javascript").contains(type)) throw upstream();
            return new Result(jsonp ? "application/javascript;charset=UTF-8" : "application/json;charset=UTF-8", response.body());
        } catch (ApiException failure) {
            throw failure;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt(); throw unavailable();
        } catch (Exception failure) {
            // Do not attach raw transport exceptions: their URI can contain the security code and search terms.
            throw upstream();
        } finally {
            inFlight.release();
        }
    }

    private static String decode(byte[] bytes) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
    private static void append(StringBuilder query, String key, String value) {
        if (!query.isEmpty()) query.append('&');
        query.append(URLEncoder.encode(key, StandardCharsets.UTF_8)).append('=').append(URLEncoder.encode(value, StandardCharsets.UTF_8));
    }
    private static ApiException invalid() { return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "地图查询参数不正确"); }
    private static ApiException unavailable() { return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "MAP_UNAVAILABLE", "地图服务暂不可用，请使用文字地点"); }
    private static ApiException upstream() { return new ApiException(HttpStatus.BAD_GATEWAY, "MAP_UPSTREAM_UNAVAILABLE", "地图服务暂不可用，请稍后重试"); }
    public record Result(String contentType, byte[] body) {}
}

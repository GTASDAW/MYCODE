package com.example.gather.maps;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Semaphore;

/** One WGS84 point enters the fixed AMap GPS-to-GCJ02 endpoint. No point or key is logged or persisted. */
@Service
public class LocationCoordinateConverter {
    private final LocationCheckInConfiguration configuration;
    private final AmapTransport transport;
    private final ObjectMapper json;
    private final Semaphore inFlight = new Semaphore(16);
    public LocationCoordinateConverter(LocationCheckInConfiguration configuration, AmapTransport transport, ObjectMapper json) {
        this.configuration = configuration; this.transport = transport; this.json = json;
    }
    public Point convert(BigDecimal longitude, BigDecimal latitude) {
        if (!configuration.enabled()) throw unavailable();
        if (TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Coordinate conversion must precede the attendance transaction");
        if (!inFlight.tryAcquire()) throw unavailable();
        try {
            var uri = URI.create("https://restapi.amap.com/v3/assistant/coordinate/convert?coordsys=gps&output=JSON&locations="
                + longitude.toPlainString() + "," + latitude.toPlainString() + "&key=" + configuration.webServiceKey());
            var response = transport.get(uri);
            if (response.status() != 200 || response.body() == null || response.body().length > AmapTransport.MAX_RESPONSE_BYTES
                || response.contentType() == null || !response.contentType().toLowerCase(java.util.Locale.ROOT).startsWith("application/json"))
                throw unavailable();
            var body = json.readTree(new String(response.body(), StandardCharsets.UTF_8));
            if (!"1".equals(body.path("status").asString()) || !body.path("locations").isString()) throw unavailable();
            String[] values = body.path("locations").asString().split(",", -1);
            if (values.length != 2 || !values[0].matches("-?\\d{1,3}(?:\\.\\d{1,15})?")
                || !values[1].matches("-?\\d{1,2}(?:\\.\\d{1,15})?")) throw unavailable();
            var point = new Point(new BigDecimal(values[0]), new BigDecimal(values[1]));
            if (point.longitude().abs().compareTo(BigDecimal.valueOf(180)) > 0
                || point.latitude().abs().compareTo(BigDecimal.valueOf(90)) > 0) throw unavailable();
            return point;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt(); throw unavailable();
        } catch (Exception exception) {
            // Upstream exceptions can include request URIs, GPS coordinates and the Web service key.
            throw unavailable();
        } finally {
            inFlight.release();
        }
    }
    private static ApiException unavailable() {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "LOCATION_CHECK_IN_UNAVAILABLE", "定位签到服务暂时不可用，请稍后重试或联系管理员签到");
    }
    public record Point(BigDecimal longitude, BigDecimal latitude) {}
}

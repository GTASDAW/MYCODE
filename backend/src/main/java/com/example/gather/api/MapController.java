package com.example.gather.api;

import com.example.gather.maps.MapConfiguration;
import com.example.gather.maps.MapProxyService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MapController {
    private final MapConfiguration configuration;
    private final MapProxyService proxy;
    public MapController(MapConfiguration configuration, MapProxyService proxy) { this.configuration = configuration; this.proxy = proxy; }

    @GetMapping("/api/maps/config")
    ResponseEntity<MapConfiguration.View> configuration() {
        return ResponseEntity.ok().header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").body(configuration.view());
    }

    @GetMapping({"/api/_AMapService/v3/place/text", "/api/_AMapService/v3/assistant/inputtips",
        "/api/_AMapService/v3/geocode/regeo", "/api/_AMapService/v4/map/styles"})
    ResponseEntity<byte[]> get(@RequestParam MultiValueMap<String, String> parameters, HttpServletRequest request) {
        if (request.getContentLengthLong() > 0 || request.getHeader("Transfer-Encoding") != null)
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "地图查询不接受请求正文");
        String path = request.getServletPath();
        if (path.isEmpty()) path = request.getRequestURI().substring(request.getContextPath().length());
        var result = proxy.get(path.substring(MapConfiguration.SERVICE_HOST.length()), parameters,
            request.getQueryString() == null ? 0 : request.getQueryString().length());
        return ResponseEntity.ok().header("Content-Type", result.contentType()).header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff").body(result.body());
    }
}

package com.example.gather.maps;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public final class MapConfiguration {
    public static final String SERVICE_HOST = "/api/_AMapService";
    private final String jsKey;
    private final String securityCode;

    public MapConfiguration(@Value("${app.maps.js-key:}") String jsKey,
                            @Value("${app.maps.js-security-code:}") String securityCode) {
        this.jsKey = valid(jsKey) ? jsKey : null;
        this.securityCode = valid(securityCode) ? securityCode : null;
    }

    private static boolean valid(String value) { return value != null && value.matches("[A-Za-z0-9_-]{16,128}"); }
    public boolean enabled() { return jsKey != null && securityCode != null; }
    public View view() { return new View(enabled(), enabled() ? jsKey : null, SERVICE_HOST); }
    String jsKey() { return jsKey; }
    String securityCode() { return securityCode; }
    public record View(boolean enabled, String jsKey, String serviceHost) {}
}

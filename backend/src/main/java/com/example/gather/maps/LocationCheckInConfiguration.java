package com.example.gather.maps;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** This backend-only Web service key is independent of the browser JavaScript credentials. */
@Component
public final class LocationCheckInConfiguration {
    private final String webServiceKey;
    public LocationCheckInConfiguration(@Value("${app.maps.web-service-key:}") String key) {
        this.webServiceKey = key != null && key.matches("[A-Za-z0-9_-]{16,128}") ? key : null;
    }
    public boolean enabled() { return webServiceKey != null; }
    String webServiceKey() { return webServiceKey; }
}

package com.example.gather.maps;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/** This backend-only Web service key is independent of the browser JavaScript credentials. */
@Component
public final class LocationCheckInConfiguration {
    private final String webServiceKey;
    private final boolean gcj02DiagnosticEnabled;

    public LocationCheckInConfiguration(String key) {
        this(key, false);
    }

    @Autowired
    public LocationCheckInConfiguration(@Value("${app.maps.web-service-key:}") String key,
                                        @Value("${app.maps.gcj02-diagnostic-enabled:false}") boolean gcj02DiagnosticEnabled) {
        this.webServiceKey = key != null && key.matches("[A-Za-z0-9_-]{16,128}") ? key : null;
        this.gcj02DiagnosticEnabled = gcj02DiagnosticEnabled;
    }
    public boolean enabled() { return webServiceKey != null; }
    public boolean gcj02DiagnosticEnabled() { return gcj02DiagnosticEnabled; }
    String webServiceKey() { return webServiceKey; }
}

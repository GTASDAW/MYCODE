package com.example.gather.api;

import com.example.gather.monitoring.MonitoringModels.MonitoringView;
import com.example.gather.monitoring.MonitoringService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** SecurityConfiguration enforces ADMIN for the complete /api/admin subtree. */
@RestController
@RequestMapping("/api/admin")
public class MonitoringController {
    private final MonitoringService monitoring;

    public MonitoringController(MonitoringService monitoring) { this.monitoring = monitoring; }

    @GetMapping("/monitoring")
    MonitoringView monitoring() { return monitoring.snapshot(); }
}

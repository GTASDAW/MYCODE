package com.example.gather.api;

import com.example.gather.api.AuditLogModels.*;
import com.example.gather.service.AuditLogService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/admin/audit-logs")
public class AuditLogController {
    private final AuditLogService audit;

    public AuditLogController(AuditLogService audit) { this.audit = audit; }

    @GetMapping
    AuditLogPageView search(@RequestParam(defaultValue = "1") int page,
                            @RequestParam(defaultValue = "10") int pageSize,
                            @RequestParam(defaultValue = "ALL") String action,
                            @RequestParam(required = false) Long activityId) {
        return audit.search(page, pageSize, action, activityId);
    }

    @GetMapping("/{id}")
    AuditLogDetailView detail(@PathVariable long id) { return audit.detail(id); }
}

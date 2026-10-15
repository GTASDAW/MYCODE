package com.example.gather.api;

import com.example.gather.api.AttendanceModels.AttendancePageView;
import com.example.gather.service.AttendanceService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/admin/attendance")
public class AttendanceController {
    private final AttendanceService attendance;

    public AttendanceController(AttendanceService attendance) { this.attendance = attendance; }

    @GetMapping
    AttendancePageView search(@RequestParam(required = false) String from,
                              @RequestParam(required = false) String to,
                              @RequestParam(defaultValue = "1") int page,
                              @RequestParam(defaultValue = "10") int pageSize) {
        return attendance.search(from, to, page, pageSize);
    }
}

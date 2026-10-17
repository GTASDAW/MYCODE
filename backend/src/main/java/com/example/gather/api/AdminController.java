package com.example.gather.api;

import com.example.gather.api.AdminModels.*;
import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.api.ApiModels.CreateActivityRequest;
import com.example.gather.api.ApiModels.EditActivityRequest;
import com.example.gather.api.ApiModels.CancelActivityRequest;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.AdminService;
import com.example.gather.service.CheckInService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.net.URI;

@RestController
@RequestMapping("/api/admin")
public class AdminController {
    private final AdminService admin;
    private final ActivityService activities;
    private final CheckInService checkIns;

    public AdminController(AdminService admin, ActivityService activities, CheckInService checkIns) {
        this.admin = admin;
        this.activities = activities;
        this.checkIns = checkIns;
    }

    @GetMapping("/overview")
    OverviewView overview() { return admin.overview(); }

    @GetMapping("/activities")
    ActivityPageView list(@RequestParam(defaultValue = "1") int page,
                          @RequestParam(defaultValue = "10") int pageSize,
                          @RequestParam(defaultValue = "") String keyword,
                          @RequestParam(defaultValue = "ALL") String status,
                          @RequestParam(required = false) String category,
                          @AuthenticationPrincipal AppUserDetails principal) {
        return admin.activities(page, pageSize, keyword, status, category == null ? "ALL" : category, principal.id());
    }

    @GetMapping("/activities/{id}/registrations")
    RosterPageView roster(@PathVariable long id,
                          @RequestParam(defaultValue = "1") int page,
                          @RequestParam(defaultValue = "10") int pageSize,
                          @RequestParam(defaultValue = "ALL") String status,
                          @RequestParam(defaultValue = "ALL") String checkInStatus,
                          @AuthenticationPrincipal AppUserDetails principal) {
        return admin.roster(id, page, pageSize, status, checkInStatus, principal.id());
    }

    @PostMapping("/activities/{id}/registrations/{registrationId}/check-in")
    RosterView checkIn(@PathVariable long id, @PathVariable long registrationId,
                       @AuthenticationPrincipal AppUserDetails principal) {
        return checkIns.checkIn(id, registrationId, principal.id());
    }

    @GetMapping("/activities/{id}/registrations/export")
    ResponseEntity<byte[]> export(@PathVariable long id,
                                  @RequestParam(defaultValue = "ALL") String status,
                                  @RequestParam(defaultValue = "ALL") String checkInStatus,
                                  @AuthenticationPrincipal AppUserDetails principal) {
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"activity-" + id + "-registrations.csv\"")
            .header(HttpHeaders.CACHE_CONTROL, "no-store")
            .body(admin.exportRoster(id, status, checkInStatus, principal.id()));
    }

    @PostMapping("/activities")
    ResponseEntity<ActivityView> create(@Valid @RequestBody CreateActivityRequest request,
                                        @AuthenticationPrincipal AppUserDetails principal) {
        ActivityView activity = activities.create(request, principal.id());
        return ResponseEntity.created(URI.create("/api/activities/" + activity.id())).body(activity);
    }

    @PatchMapping("/activities/{id}")
    ActivityView edit(@PathVariable long id, @Valid @RequestBody EditActivityRequest request,
                      @AuthenticationPrincipal AppUserDetails principal) {
        return activities.edit(id, request, principal.id());
    }

    @PostMapping("/activities/{id}/cancel")
    ActivityView cancel(@PathVariable long id, @Valid @RequestBody CancelActivityRequest request,
                        @AuthenticationPrincipal AppUserDetails principal) {
        return activities.cancel(id, request, principal.id());
    }
}

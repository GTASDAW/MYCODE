package com.example.gather.api;

import com.example.gather.api.ApiModels.*;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.RegistrationService;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api")
public class ActivityController {
    private final ActivityService activities;
    private final RegistrationService registrations;

    public ActivityController(ActivityService activities, RegistrationService registrations) {
        this.activities = activities;
        this.registrations = registrations;
    }

    @GetMapping("/activities")
    List<ActivityView> list(@AuthenticationPrincipal AppUserDetails principal) {
        return activities.list(principal == null ? null : principal.id());
    }

    @GetMapping("/activities/{id}")
    ActivityView detail(@PathVariable long id, @AuthenticationPrincipal AppUserDetails principal) {
        return activities.get(id, principal == null ? null : principal.id());
    }

    @PostMapping("/activities/{id}/registration")
    ActivityView register(@PathVariable long id, @AuthenticationPrincipal AppUserDetails principal) {
        return registrations.register(id, principal.id());
    }

    @DeleteMapping("/activities/{id}/registration")
    ActivityView cancel(@PathVariable long id, @AuthenticationPrincipal AppUserDetails principal) {
        return registrations.cancel(id, principal.id());
    }

    @GetMapping("/me/registrations")
    List<RegistrationView> mine(@AuthenticationPrincipal AppUserDetails principal) {
        return registrations.mine(principal.id());
    }
}

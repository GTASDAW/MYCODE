package com.example.gather.api;

import com.example.gather.api.CheckInModels.LocationCheckInRequest;
import com.example.gather.api.MyRegistrationModels.MyRegistrationView;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.LocationCheckInService;
import jakarta.validation.Valid;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/me/registrations")
public class LocationCheckInController {
    private final LocationCheckInService checkIns;
    public LocationCheckInController(LocationCheckInService checkIns) { this.checkIns = checkIns; }
    @PostMapping("/{registrationId}/check-in")
    MyRegistrationView checkIn(@PathVariable long registrationId, @Valid @RequestBody LocationCheckInRequest request,
                               @AuthenticationPrincipal AppUserDetails principal) {
        return checkIns.checkIn(registrationId, principal.id(), request);
    }

    @PostMapping("/{registrationId}/check-in/gcj02")
    MyRegistrationView checkInGcj02(@PathVariable long registrationId, @Valid @RequestBody LocationCheckInRequest request,
                                    @AuthenticationPrincipal AppUserDetails principal) {
        return checkIns.checkInGcj02(registrationId, principal.id(), request);
    }
}

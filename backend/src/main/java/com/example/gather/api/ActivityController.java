package com.example.gather.api;

import com.example.gather.api.ApiModels.*;
import com.example.gather.api.MyRegistrationModels.MyRegistrationPageView;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityService;
import com.example.gather.service.RegistrationService;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.http.HttpStatus;
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

    @GetMapping("/activities/search")
    ActivitySearchPageView search(@RequestParam(defaultValue = "1") int page,
                                  @RequestParam(defaultValue = "12") int pageSize,
                                  @RequestParam(defaultValue = "") String keyword,
                                  @RequestParam(defaultValue = "ALL") String status,
                                  @RequestParam(required = false) String category,
                                  @RequestParam(required = false) String startDateFrom,
                                  @RequestParam(required = false) String startDateTo,
                                  @AuthenticationPrincipal AppUserDetails principal) {
        return activities.search(page, pageSize, keyword, status, category == null ? "ALL" : category,
            startDateFrom, startDateTo, principal == null ? null : principal.id());
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

    @GetMapping("/me/registrations/search")
    MyRegistrationPageView searchMine(@RequestParam(required = false) String page,
                                      @RequestParam(required = false) String pageSize,
                                      @RequestParam(required = false) String status,
                                      @AuthenticationPrincipal AppUserDetails principal) {
        return registrations.searchMine(principal.id(), integer(page, 1), integer(pageSize, 10),
            status == null ? "ALL" : status);
    }

    private static int integer(String text, int fallback) {
        if (text == null) return fallback;
        try {
            if (!text.matches("[0-9]+")) throw new NumberFormatException();
            return Integer.parseInt(text);
        } catch (NumberFormatException exception) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "页码和每页数量应为有效整数");
        }
    }
}

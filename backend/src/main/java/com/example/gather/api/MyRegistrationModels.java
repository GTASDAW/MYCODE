package com.example.gather.api;

import com.example.gather.api.ApiModels.ActivityView;
import java.time.Instant;
import java.util.List;

public final class MyRegistrationModels {
    private MyRegistrationModels() {}

    public record MyRegistrationView(long id, String status, ActivityView activity, Instant checkedInAt) {}
    public record MyRegistrationSummary(long activeRegistrations, long waitingRegistrations,
                                        long cancelledRegistrations, long checkedInRegistrations) {}
    public record MyRegistrationPageView(List<MyRegistrationView> items, long total, int page, int pageSize,
                                         MyRegistrationSummary summary) {}
}

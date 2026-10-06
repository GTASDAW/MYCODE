package com.example.gather.api;

import com.example.gather.api.ApiModels.ActivityView;
import java.time.Instant;
import java.util.List;

public final class AdminModels {
    private AdminModels() {}

    public record OverviewView(long totalActivities, long upcomingActivities, long startedActivities,
                               long fullActivities, long activeRegistrations, long waitingRegistrations,
                               long availableSeats) {}

    public record ActivityPageView(List<ActivityView> items, long total, int page, int pageSize) {}

    public record RosterView(long id, long userId, String username, String displayName, String status,
                             Instant createdAt, Instant updatedAt) {}

    public record RosterPageView(ActivityView activity, List<RosterView> items, long total, int page, int pageSize) {}
}

package com.example.gather.api;

import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.domain.RosterRow;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class AdminModels {
    private AdminModels() {}

    public record OverviewView(long totalActivities, long upcomingActivities, long startedActivities,
                               long fullActivities, long activeRegistrations, long waitingRegistrations,
                               long availableSeats, long cancelledActivities) {}

    public record ActivityPageView(List<ActivityView> items, long total, int page, int pageSize) {}

    public record RosterView(long id, long userId, String username, String displayName, String status,
                             Instant createdAt, Instant updatedAt, Instant checkedInAt, Long checkedInBy,
                             String checkedInByDisplayName) {
        public static RosterView from(RosterRow row) {
            return new RosterView(row.id(), row.userId(), row.username(), row.displayName(), row.status(),
                row.createdAt().toInstant(ZoneOffset.UTC), row.updatedAt().toInstant(ZoneOffset.UTC),
                row.checkedInAt() == null ? null : row.checkedInAt().toInstant(ZoneOffset.UTC),
                row.checkedInBy(), row.checkedInByDisplayName());
        }
    }

    public record RosterSummaryView(long activeRegistrations, long checkedInRegistrations, long notCheckedInRegistrations) {}

    public record RosterPageView(ActivityView activity, List<RosterView> items, long total, int page, int pageSize,
                                 RosterSummaryView summary) {}
}

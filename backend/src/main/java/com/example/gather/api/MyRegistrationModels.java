package com.example.gather.api;

import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.domain.MyRegistrationRow;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class MyRegistrationModels {
    private MyRegistrationModels() {}

    public record MyRegistrationView(long id, String status, ActivityView activity, Instant checkedInAt,
                                      String checkInMethod, long checkInVersion) {
        public static MyRegistrationView from(MyRegistrationRow row, Instant now) {
            return new MyRegistrationView(row.registrationId(), row.status(), ActivityView.from(row.activity(), now),
                row.checkedInAt() == null ? null : row.checkedInAt().toInstant(ZoneOffset.UTC), row.checkInMethod(), row.checkInVersion());
        }
    }
    public record MyRegistrationSummary(long activeRegistrations, long waitingRegistrations,
                                        long cancelledRegistrations, long checkedInRegistrations) {}
    public record MyRegistrationPageView(List<MyRegistrationView> items, long total, int page, int pageSize,
                                         MyRegistrationSummary summary, boolean locationCheckInEnabled) {
        @JsonProperty("locationCheckInGcj02Supported")
        public boolean locationCheckInGcj02Supported() { return true; }
    }
}

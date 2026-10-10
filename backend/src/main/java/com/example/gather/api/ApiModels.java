package com.example.gather.api;

import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.UserRow;
import jakarta.validation.constraints.*;
import java.io.Serializable;
import java.io.Serial;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class ApiModels {
    private ApiModels() {}

    public record UserView(long id, String username, String displayName, String role) implements Serializable {
        @Serial
        private static final long serialVersionUID = 1L;

        public static UserView from(UserRow user) {
            return new UserView(user.id(), user.username(), user.displayName(), user.role());
        }
    }

    public record ActivityView(long id, String title, String description, String location, Instant startsAt,
                               int capacity, int registeredCount, int waitingCount, String registrationStatus, boolean closed,
                               boolean cancelled, String cancellationReason, Instant cancelledAt) {
        public static ActivityView from(ActivityRow row, Instant now) {
            Instant start = row.startsAt().toInstant(ZoneOffset.UTC);
            return new ActivityView(row.id(), row.title(), row.description(), row.location(), start,
                row.capacity(), row.registeredCount(), row.waitingCount(), row.registrationStatus(),
                row.cancelledAt() != null || !start.isAfter(now), row.cancelledAt() != null, row.cancellationReason(),
                row.cancelledAt() == null ? null : row.cancelledAt().toInstant(ZoneOffset.UTC));
        }
    }

    public record RegistrationView(long id, String status, ActivityView activity) {}
    public record ActivitySearchSummary(long upcomingActivities, long availableSeats) {}
    public record ActivitySearchPageView(List<ActivityView> items, long total, int page, int pageSize,
                                         ActivitySearchSummary summary) {}
    public record CsrfView(String token, String headerName) {}
    public record ErrorView(String code, String message) {}

    public record CreateActivityRequest(
        @NotBlank(message = "请填写活动标题") @Size(max = 100, message = "标题最多 100 字") String title,
        @NotBlank(message = "请填写活动介绍") @Size(max = 10000, message = "介绍最多 10000 字") String description,
        @NotBlank(message = "请填写活动地点") @Size(max = 200, message = "地点最多 200 字") String location,
        @NotNull(message = "请填写开始时间") @Future(message = "开始时间必须在未来") Instant startsAt,
        @Min(value = 1, message = "名额至少为 1") @Max(value = 10000, message = "名额最多为 10000") int capacity
    ) {}

    public record EditActivityRequest(
        @NotBlank(message = "请填写活动标题") @Size(max = 100, message = "标题最多 100 字") String title,
        @NotBlank(message = "请填写活动介绍") @Size(max = 10000, message = "介绍最多 10000 字") String description,
        @NotBlank(message = "请填写活动地点") @Size(max = 200, message = "地点最多 200 字") String location
    ) {}

    public record CancelActivityRequest(
        @NotBlank(message = "请填写取消原因") @Size(max = 500, message = "取消原因最多 500 字") String reason
    ) {}
}

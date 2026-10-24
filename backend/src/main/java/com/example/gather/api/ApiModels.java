package com.example.gather.api;

import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.UserRow;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonSetter;
import jakarta.validation.constraints.*;
import java.io.Serializable;
import java.io.Serial;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class ApiModels {
    private ApiModels() {}

    public record UserView(long id, String username, String displayName, String role, String avatarUrl) implements Serializable {
        @Serial
        private static final long serialVersionUID = 1L;

        public UserView(long id, String username, String displayName, String role) {
            this(id, username, displayName, role, null);
        }

        public static UserView from(UserRow user) {
            return new UserView(user.id(), user.username(), user.displayName(), user.role(),
                user.avatarHash() == null ? null : "/api/me/avatar?v=" + user.avatarHash());
        }
    }

    public record ActivityView(long id, String title, String description, String location, Instant startsAt, Instant endsAt, Instant registrationDeadline,
                               int capacity, int registeredCount, int waitingCount, Long waitingPosition, String registrationStatus, boolean closed,
                               boolean cancelled, String cancellationReason, Instant cancelledAt, String category, String coverUrl, boolean registrationClosed,
                               LocationPoint locationPoint) {
        public ActivityView(long id, String title, String description, String location, Instant startsAt, Instant endsAt, Instant registrationDeadline,
                            int capacity, int registeredCount, int waitingCount, Long waitingPosition, String registrationStatus, boolean closed,
                            boolean cancelled, String cancellationReason, Instant cancelledAt, String category, String coverUrl, boolean registrationClosed) {
            this(id, title, description, location, startsAt, endsAt, registrationDeadline, capacity, registeredCount, waitingCount,
                waitingPosition, registrationStatus, closed, cancelled, cancellationReason, cancelledAt, category, coverUrl, registrationClosed, null);
        }
        public static ActivityView from(ActivityRow row, Instant now) {
            Instant start = row.startsAt().toInstant(ZoneOffset.UTC);
            Instant deadline = row.registrationDeadline() == null ? null : row.registrationDeadline().toInstant(ZoneOffset.UTC);
            boolean closed = row.cancelledAt() != null || !start.isAfter(now);
            Long position = row.cancelledAt() == null && "WAITING".equals(row.registrationStatus())
                && row.waitingPosition() != null && row.waitingPosition() > 0 && row.waitingPosition() <= row.waitingCount()
                ? row.waitingPosition() : null;
            return new ActivityView(row.id(), row.title(), row.description(), row.location(), start,
                row.endsAt() == null ? null : row.endsAt().toInstant(ZoneOffset.UTC),
                deadline,
                row.capacity(), row.registeredCount(), row.waitingCount(), position, row.registrationStatus(),
                closed, row.cancelledAt() != null, row.cancellationReason(),
                row.cancelledAt() == null ? null : row.cancelledAt().toInstant(ZoneOffset.UTC), row.category(),
                row.coverHash() == null ? null : "/api/activities/" + row.id() + "/cover?v=" + row.coverHash(),
                closed || deadline != null && !deadline.isAfter(now), LocationPoint.from(row.locationLongitude(), row.locationLatitude()));
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
        @Min(value = 1, message = "名额至少为 1") @Max(value = 10000, message = "名额最多为 10000") int capacity,
        String category,
        Instant endsAt,
        Instant registrationDeadline,
        LocationPoint locationPoint
    ) {
        public CreateActivityRequest(String title, String description, String location, Instant startsAt, int capacity, String category,
                                     Instant endsAt, Instant registrationDeadline) {
            this(title, description, location, startsAt, capacity, category, endsAt, registrationDeadline, null);
        }
        public CreateActivityRequest(String title, String description, String location, Instant startsAt, int capacity) {
            this(title, description, location, startsAt, capacity, null, null, null);
        }

        public CreateActivityRequest(String title, String description, String location, Instant startsAt, int capacity, String category) {
            this(title, description, location, startsAt, capacity, category, null, null);
        }

        public CreateActivityRequest(String title, String description, String location, Instant startsAt, int capacity, String category, Instant endsAt) {
            this(title, description, location, startsAt, capacity, category, endsAt, null);
        }
    }

    public static final class EditActivityRequest {
        @NotBlank(message = "请填写活动标题") @Size(max = 100, message = "标题最多 100 字")
        @JsonProperty private final String title;
        @NotBlank(message = "请填写活动介绍") @Size(max = 10000, message = "介绍最多 10000 字")
        @JsonProperty private final String description;
        @NotBlank(message = "请填写活动地点") @Size(max = 200, message = "地点最多 200 字")
        @JsonProperty private final String location;
        @JsonProperty private final String category;
        private LocationPoint locationPoint;
        private boolean locationPointSpecified;

        @JsonCreator
        public EditActivityRequest(@JsonProperty("title") String title, @JsonProperty("description") String description,
                                   @JsonProperty("location") String location, @JsonProperty("category") String category) {
            this.title = title; this.description = description; this.location = location; this.category = category;
        }
        public EditActivityRequest(String title, String description, String location) { this(title, description, location, null); }
        public EditActivityRequest(String title, String description, String location, String category, LocationPoint point) {
            this(title, description, location, category); setLocationPoint(point);
        }
        @JsonSetter("locationPoint")
        public void setLocationPoint(LocationPoint point) { locationPoint = point; locationPointSpecified = true; }
        public String title() { return title; }
        public String description() { return description; }
        public String location() { return location; }
        public String category() { return category; }
        public LocationPoint locationPoint() { return locationPoint; }
        public boolean locationPointSpecified() { return locationPointSpecified; }
    }

    public record CancelActivityRequest(
        @NotBlank(message = "请填写取消原因") @Size(max = 500, message = "取消原因最多 500 字") String reason
    ) {}
}

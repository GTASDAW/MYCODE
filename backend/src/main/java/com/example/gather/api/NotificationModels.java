package com.example.gather.api;

import com.example.gather.domain.NotificationRow;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class NotificationModels {
    private NotificationModels() {}

    public record NotificationView(long id, String type, long activityId, String activityTitle,
                                   String cancellationReason, Instant createdAt, Instant readAt) {
        public static NotificationView from(NotificationRow row) {
            return new NotificationView(row.id(), row.type(), row.activityId(), row.activityTitle(), row.cancellationReason(),
                row.createdAt().toInstant(ZoneOffset.UTC), row.readAt() == null ? null : row.readAt().toInstant(ZoneOffset.UTC));
        }
    }

    public record NotificationPageView(List<NotificationView> items, long total, int page, int pageSize, long unreadCount) {}
    public record UnreadCountView(long unreadCount) {}
}

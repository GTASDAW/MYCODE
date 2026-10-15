package com.example.gather.api;

import com.example.gather.domain.AuditLogRow;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

public final class AuditLogModels {
    private AuditLogModels() {}

    public record AuditChange(String field, String before, String after) {}

    public record AuditLogView(long id, String action, long activityId, String activityTitle,
                               long actorUserId, String actorUsername, String actorDisplayName,
                               Long registrationId, String targetUsername, String targetDisplayName,
                               Instant occurredAt) {
        public static AuditLogView from(AuditLogRow row) {
            return new AuditLogView(row.id(), row.action(), row.activityId(), row.activityTitle(),
                row.actorUserId(), row.actorUsername(), row.actorDisplayName(), row.registrationId(),
                row.targetUsername(), row.targetDisplayName(), row.occurredAt().toInstant(ZoneOffset.UTC));
        }
    }

    public record AuditLogPageView(List<AuditLogView> items, long total, int page, int pageSize) {}

    public record AuditLogDetailView(long id, String action, long activityId, String activityTitle,
                                     long actorUserId, String actorUsername, String actorDisplayName,
                                     Long registrationId, String targetUsername, String targetDisplayName,
                                     Instant occurredAt, List<AuditChange> changes) {
        public static AuditLogDetailView from(AuditLogRow row, List<AuditChange> changes) {
            return new AuditLogDetailView(row.id(), row.action(), row.activityId(), row.activityTitle(),
                row.actorUserId(), row.actorUsername(), row.actorDisplayName(), row.registrationId(),
                row.targetUsername(), row.targetDisplayName(), row.occurredAt().toInstant(ZoneOffset.UTC), changes);
        }
    }
}

package com.example.gather.domain;

import java.time.LocalDateTime;

/** List metadata deliberately excludes potentially long before/after JSON. */
public record AuditLogRow(long id, String action, long activityId, String activityTitle,
                          long actorUserId, String actorUsername, String actorDisplayName,
                          Long registrationId, String targetUsername, String targetDisplayName,
                          LocalDateTime occurredAt) {}

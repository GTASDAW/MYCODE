package com.example.gather.domain;

/** Current database values are copied into the immutable event rather than using Session names. */
public record AuditLogContext(String activityTitle, String actorUsername, String actorDisplayName,
                              String targetUsername, String targetDisplayName) {}

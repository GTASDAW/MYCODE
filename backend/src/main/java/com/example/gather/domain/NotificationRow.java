package com.example.gather.domain;

import java.time.LocalDateTime;

public record NotificationRow(long id, String type, long activityId, String activityTitle,
                              String cancellationReason, LocalDateTime createdAt, LocalDateTime readAt) {}

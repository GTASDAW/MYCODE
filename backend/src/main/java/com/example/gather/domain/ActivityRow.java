package com.example.gather.domain;

import java.time.LocalDateTime;

public record ActivityRow(long id, String title, String description, String location,
                          LocalDateTime startsAt, LocalDateTime endsAt, LocalDateTime registrationDeadline, int capacity, int registeredCount, int waitingCount, Long waitingPosition,
                          String registrationStatus, LocalDateTime cancelledAt, String cancellationReason, String category,
                          String coverHash) {}

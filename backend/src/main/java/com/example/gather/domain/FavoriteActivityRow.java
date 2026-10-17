package com.example.gather.domain;

import java.time.LocalDateTime;

public record FavoriteActivityRow(long id, String title, String description, String location,
    LocalDateTime startsAt, int capacity, int registeredCount, int waitingCount,
    String registrationStatus, LocalDateTime cancelledAt, String cancellationReason, String category,
    LocalDateTime favoritedAt) {
    public ActivityRow activity() {
        return new ActivityRow(id, title, description, location, startsAt, capacity,
            registeredCount, waitingCount, registrationStatus, cancelledAt, cancellationReason, category);
    }
}

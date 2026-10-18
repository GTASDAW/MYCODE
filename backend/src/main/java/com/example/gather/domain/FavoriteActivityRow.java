package com.example.gather.domain;

import java.time.LocalDateTime;

public record FavoriteActivityRow(long id, String title, String description, String location,
    LocalDateTime startsAt, LocalDateTime endsAt, int capacity, int registeredCount, int waitingCount,
    String registrationStatus, LocalDateTime cancelledAt, String cancellationReason, String category,
    String coverHash, LocalDateTime favoritedAt) {
    public ActivityRow activity() {
        return new ActivityRow(id, title, description, location, startsAt, endsAt, capacity,
            registeredCount, waitingCount, registrationStatus, cancelledAt, cancellationReason, category, coverHash);
    }
}

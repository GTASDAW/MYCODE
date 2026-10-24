package com.example.gather.domain;

import java.time.LocalDateTime;

public record FavoriteActivityRow(long id, String title, String description, String location,
    LocalDateTime startsAt, LocalDateTime endsAt, LocalDateTime registrationDeadline, int capacity, int registeredCount, int waitingCount, Long waitingPosition,
    String registrationStatus, LocalDateTime cancelledAt, String cancellationReason, String category,
    String coverHash, java.math.BigDecimal locationLongitude, java.math.BigDecimal locationLatitude, LocalDateTime favoritedAt) {
    public ActivityRow activity() {
        return new ActivityRow(id, title, description, location, startsAt, endsAt, registrationDeadline, capacity,
            registeredCount, waitingCount, waitingPosition, registrationStatus, cancelledAt, cancellationReason, category, coverHash, locationLongitude, locationLatitude);
    }
}

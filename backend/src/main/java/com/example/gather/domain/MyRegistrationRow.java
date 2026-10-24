package com.example.gather.domain;

import java.time.LocalDateTime;

/** Read projection keeps registration and activity IDs distinct, without the check-in administrator identity. */
public record MyRegistrationRow(long registrationId, String status, LocalDateTime checkedInAt, String checkInMethod, long checkInVersion,
                                long activityId, String title, String description, String location,
                                LocalDateTime startsAt, LocalDateTime endsAt, LocalDateTime registrationDeadline, int capacity, int registeredCount, int waitingCount, Long waitingPosition,
                                LocalDateTime cancelledAt, String cancellationReason, String category, String coverHash,
                                java.math.BigDecimal locationLongitude, java.math.BigDecimal locationLatitude) {
    public ActivityRow activity() {
        return new ActivityRow(activityId, title, description, location, startsAt, endsAt, registrationDeadline, capacity,
            registeredCount, waitingCount, waitingPosition, status, cancelledAt, cancellationReason, category, coverHash, locationLongitude, locationLatitude);
    }
}

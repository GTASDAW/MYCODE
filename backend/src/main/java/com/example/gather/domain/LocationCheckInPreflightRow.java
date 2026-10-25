package com.example.gather.domain;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/** Cheap eligibility read before sending a location upstream; the locked writer remains authoritative. */
public record LocationCheckInPreflightRow(long id, long activityId, long userId, String status,
                                          LocalDateTime checkedInAt, long checkInVersion,
                                          LocalDateTime cancelledAt, LocalDateTime endsAt,
                                          BigDecimal locationLongitude, BigDecimal locationLatitude) {}

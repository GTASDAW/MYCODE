package com.example.gather.domain;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/** Separate read after the existing activity lock; attendance must not expand its hot projection. */
public record LocationCheckInTarget(LocalDateTime endsAt, BigDecimal locationLongitude, BigDecimal locationLatitude) {}

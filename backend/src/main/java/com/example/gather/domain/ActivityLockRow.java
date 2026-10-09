package com.example.gather.domain;

import java.time.LocalDateTime;

/** Only the fields needed after acquiring an activity's primary-key lock. */
public record ActivityLockRow(LocalDateTime startsAt, int capacity, int registeredCount) {}

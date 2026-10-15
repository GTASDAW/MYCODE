package com.example.gather.domain;

import java.time.LocalDateTime;

public record AttendanceRow(long id, String title, String location, LocalDateTime startsAt, int capacity,
                            long activeRegistrations, long checkedInRegistrations) {}

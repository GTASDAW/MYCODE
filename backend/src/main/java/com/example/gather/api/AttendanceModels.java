package com.example.gather.api;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public final class AttendanceModels {
    private AttendanceModels() {}

    public record AttendanceSummary(long totalActivities, long activeRegistrations, long checkedInRegistrations,
                                     long notCheckedInRegistrations, BigDecimal checkInRate) {}

    public record AttendanceItem(long id, String title, String location, Instant startsAt, int capacity,
                                  long activeRegistrations, long checkedInRegistrations,
                                  long notCheckedInRegistrations, BigDecimal checkInRate) {}

    public record AttendancePageView(List<AttendanceItem> items, long total, int page, int pageSize,
                                      String from, String to, Instant asOf, AttendanceSummary summary) {}
}

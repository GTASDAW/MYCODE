package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.AttendanceModels.*;
import com.example.gather.mapper.AttendanceMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.*;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

@Service
public class AttendanceService {
    private static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final LocalDate MIN_DATE = LocalDate.of(2000, 1, 1);
    private static final LocalDate MAX_DATE = LocalDate.of(2100, 12, 31);
    private final AttendanceMapper attendance;
    private final Clock clock;

    public AttendanceService(AttendanceMapper attendance, Clock clock) {
        this.attendance = attendance;
        this.clock = clock;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AttendancePageView search(String from, String to, int page, int pageSize) {
        if (page < 1 || pageSize < 1 || pageSize > 100) invalid("页码至少为 1，每页数量应在 1 到 100 之间");
        if ((from == null) != (to == null)) invalid("开始日期与结束日期必须同时提供");
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        LocalDate last = to == null ? now.atZone(BEIJING).toLocalDate() : date(to);
        LocalDate first = from == null ? last.minusDays(29) : date(from);
        if (first.isBefore(MIN_DATE) || last.isAfter(MAX_DATE) || first.isAfter(last)
            || ChronoUnit.DAYS.between(first, last) > 365) {
            invalid("日期须在 2000-01-01 到 2100-12-31 之间，开始日期不能晚于结束日期，范围最多 366 天");
        }
        LocalDateTime fromUtc = utc(first.atStartOfDay(BEIJING).toInstant());
        LocalDateTime untilUtc = utc(last.plusDays(1).atStartOfDay(BEIJING).toInstant());
        LocalDateTime utcNow = utc(now);
        var totals = attendance.totals(fromUtc, untilUtc, utcNow);
        var items = attendance.page(fromUtc, untilUtc, utcNow, pageSize, ((long) page - 1) * pageSize).stream()
            .map(row -> new AttendanceItem(row.id(), row.title(), row.location(), row.startsAt().toInstant(ZoneOffset.UTC),
                row.capacity(), row.activeRegistrations(), row.checkedInRegistrations(),
                row.activeRegistrations() - row.checkedInRegistrations(), rate(row.checkedInRegistrations(), row.activeRegistrations())))
            .toList();
        var summary = new AttendanceSummary(totals.totalActivities(), totals.activeRegistrations(), totals.checkedInRegistrations(),
            totals.activeRegistrations() - totals.checkedInRegistrations(), rate(totals.checkedInRegistrations(), totals.activeRegistrations()));
        return new AttendancePageView(items, totals.totalActivities(), page, pageSize, first.toString(), last.toString(), now, summary);
    }

    private static LocalDate date(String value) {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) invalid("日期格式必须为 YYYY-MM-DD");
        try { return LocalDate.parse(value); }
        catch (DateTimeParseException invalidDate) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "日期不正确");
        }
    }

    private static LocalDateTime utc(Instant value) { return LocalDateTime.ofInstant(value, ZoneOffset.UTC); }

    private static BigDecimal rate(long checkedIn, long active) {
        return active == 0 ? null : BigDecimal.valueOf(checkedIn).multiply(BigDecimal.valueOf(100))
            .divide(BigDecimal.valueOf(active), 2, RoundingMode.HALF_UP);
    }

    private static void invalid(String message) { throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message); }
}

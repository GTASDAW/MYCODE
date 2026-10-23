package com.example.gather.service;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;

/** Optional inclusive Beijing dates represented as an index-friendly UTC half-open interval. */
record ActivityStartDateRange(LocalDateTime fromUtc, LocalDateTime untilUtc) {
    private static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final LocalDate MIN_DATE = LocalDate.of(2000, 1, 1);
    private static final LocalDate MAX_DATE = LocalDate.of(2100, 12, 31);

    static ActivityStartDateRange parse(String from, String to) {
        LocalDate first = from == null ? null : date(from);
        LocalDate last = to == null ? null : date(to);
        if (first != null && last != null && first.isAfter(last)) {
            throw invalid("开始日期不能晚于结束日期");
        }
        return new ActivityStartDateRange(first == null ? null : utc(first), last == null ? null : utc(last.plusDays(1)));
    }

    private static LocalDate date(String value) {
        if (!value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw invalid("日期格式必须为 YYYY-MM-DD");
        LocalDate date;
        try { date = LocalDate.parse(value); }
        catch (DateTimeParseException exception) { throw invalid("日期不正确"); }
        if (date.isBefore(MIN_DATE) || date.isAfter(MAX_DATE)) throw invalid("日期须在 2000-01-01 到 2100-12-31 之间");
        return date;
    }

    private static LocalDateTime utc(LocalDate date) {
        return LocalDateTime.ofInstant(date.atStartOfDay(BEIJING).toInstant(), ZoneOffset.UTC);
    }

    private static ApiException invalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
    }
}

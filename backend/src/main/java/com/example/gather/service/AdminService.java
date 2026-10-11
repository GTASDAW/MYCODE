package com.example.gather.service;

import com.example.gather.api.AdminModels.*;
import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.domain.ActivityRow;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.AdminMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Set;

@Service
@Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
public class AdminService {
    private static final Set<String> ACTIVITY_STATUSES = Set.of("ALL", "OPEN", "FULL", "STARTED", "UPCOMING", "CANCELLED");
    private static final Set<String> ROSTER_STATUSES = Set.of("ALL", "ACTIVE", "WAITING", "CANCELLED");
    private static final Set<String> CHECK_IN_STATUSES = Set.of("ALL", "CHECKED_IN", "NOT_CHECKED_IN");
    private static final int MAX_EXPORT_ROWS = 20_000;
    private static final int MAX_KEYWORD_LENGTH = 200;
    private final AdminMapper admin;
    private final ActivityMapper activities;
    private final Clock clock;

    public AdminService(AdminMapper admin, ActivityMapper activities, Clock clock) {
        this.admin = admin;
        this.activities = activities;
        this.clock = clock;
    }

    public OverviewView overview() {
        return admin.overview(utc(now()));
    }

    public ActivityPageView activities(int page, int pageSize, String keyword, String status, long userId) {
        validatePage(page, pageSize);
        validateStatus(status, ACTIVITY_STATUSES);
        if (keyword == null || keyword.length() > MAX_KEYWORD_LENGTH) invalid("搜索关键词最多 200 字");
        Instant now = now();
        LocalDateTime utcNow = utc(now);
        long total = admin.countActivities(utcNow, keyword, status);
        var items = admin.activities(userId, utcNow, keyword, status, pageSize, offset(page, pageSize)).stream()
            .map(row -> ActivityView.from(row, now)).toList();
        return new ActivityPageView(items, total, page, pageSize);
    }

    public RosterPageView roster(long activityId, int page, int pageSize, String status, long userId) {
        return roster(activityId, page, pageSize, status, "ALL", userId);
    }

    public RosterPageView roster(long activityId, int page, int pageSize, String status, String checkInStatus, long userId) {
        validatePage(page, pageSize);
        validateRosterStatuses(status, checkInStatus);
        Instant now = now();
        ActivityRow activity = requireActivity(activityId, userId);
        var summary = admin.rosterSummary(activityId);
        long total = admin.countRoster(activityId, status, checkInStatus);
        var items = admin.roster(activityId, status, checkInStatus, pageSize, offset(page, pageSize)).stream()
            .map(RosterView::from).toList();
        return new RosterPageView(ActivityView.from(activity, now), items, total, page, pageSize, summary);
    }

    public byte[] exportRoster(long activityId, String status, String checkInStatus, long userId) {
        validateRosterStatuses(status, checkInStatus);
        requireActivity(activityId, userId);
        // Count and rows share this read-only REPEATABLE_READ transaction; never truncate a full export.
        long total = admin.countRoster(activityId, status, checkInStatus);
        if (total > MAX_EXPORT_ROWS) {
            throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "EXPORT_TOO_LARGE", "匹配名单超过 20,000 条，请缩小筛选范围后导出");
        }
        return RegistrationCsv.encode(admin.roster(activityId, status, checkInStatus, MAX_EXPORT_ROWS, 0));
    }

    private ActivityRow requireActivity(long activityId, long userId) {
        ActivityRow activity = activities.findById(activityId, userId);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return activity;
    }

    private static void validateRosterStatuses(String status, String checkInStatus) {
        validateStatus(status, ROSTER_STATUSES);
        validateStatus(checkInStatus, CHECK_IN_STATUSES);
    }

    private Instant now() {
        // MySQL DATETIME(6) has microsecond precision. Use this same instant for SQL and response states.
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    private static LocalDateTime utc(Instant instant) { return LocalDateTime.ofInstant(instant, ZoneOffset.UTC); }
    private static long offset(int page, int pageSize) { return ((long) page - 1L) * pageSize; }

    private static void validatePage(int page, int pageSize) {
        if (page < 1 || pageSize < 1 || pageSize > 100) invalid("页码至少为 1，每页数量应在 1 到 100 之间");
    }

    private static void validateStatus(String status, Set<String> allowed) {
        if (status == null || !allowed.contains(status)) invalid("筛选状态不正确");
    }

    private static void invalid(String message) { throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message); }
}

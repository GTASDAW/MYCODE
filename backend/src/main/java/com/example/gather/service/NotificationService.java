package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.NotificationModels.*;
import com.example.gather.mapper.NotificationMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Set;

@Service
public class NotificationService {
    private static final Set<String> STATUSES = Set.of("ALL", "UNREAD", "READ");
    private final NotificationMapper notifications;
    private final Clock clock;

    public NotificationService(NotificationMapper notifications, Clock clock) {
        this.notifications = notifications;
        this.clock = clock;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public NotificationPageView page(long userId, int page, int pageSize, String status) {
        if (page < 1 || pageSize < 1 || pageSize > 100) invalid("页码至少为 1，每页数量应在 1 到 100 之间");
        if (status == null || !STATUSES.contains(status)) invalid("筛选状态不正确");
        long unreadCount = notifications.unreadCount(userId);
        long total = notifications.count(userId, status);
        var items = notifications.page(userId, status, pageSize, ((long) page - 1L) * pageSize).stream()
            .map(NotificationView::from).toList();
        return new NotificationPageView(items, total, page, pageSize, unreadCount);
    }

    @Transactional(readOnly = true)
    public UnreadCountView unreadCount(long userId) {
        return new UnreadCountView(notifications.unreadCount(userId));
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public NotificationView markRead(long id, long userId) {
        LocalDateTime now = LocalDateTime.ofInstant(clock.instant().truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC);
        notifications.markRead(id, userId, now);
        var row = notifications.findOwned(id, userId);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "NOTIFICATION_NOT_FOUND", "通知不存在");
        return NotificationView.from(row);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void promoted(long activityId, long userId) {
        if (notifications.insertPromotion(activityId, userId) != 1) {
            throw new IllegalStateException("Promotion notification requires an existing locked activity");
        }
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void activityCancelled(long activityId, String reason, LocalDateTime cancelledAt) {
        notifications.insertCancellation(activityId, reason, cancelledAt);
    }

    private static void invalid(String message) {
        throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
    }
}

package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.RegistrationRow;
import com.example.gather.mapper.ActivityMapper;
import com.example.gather.mapper.RegistrationMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.List;

@Service
public class RegistrationService {
    private final ActivityMapper activities;
    private final RegistrationMapper registrations;
    private final ActivityService activityService;
    private final Clock clock;

    public RegistrationService(ActivityMapper activities, RegistrationMapper registrations, ActivityService activityService, Clock clock) {
        this.activities = activities;
        this.registrations = registrations;
        this.activityService = activityService;
        this.clock = clock;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView register(long activityId, long userId) {
        ActivityRow activity = lockOpenActivity(activityId);
        RegistrationRow existing = registrations.findByActivityAndUser(activityId, userId);
        // Existing ACTIVE/WAITING requests are idempotent, even when the activity has since filled up.
        if (existing != null && (existing.status().equals("ACTIVE") || existing.status().equals("WAITING"))) {
            return activityService.get(activityId, userId);
        }
        if (activity.registeredCount() < activity.capacity()) {
            activities.changeRegisteredCount(activityId, 1);
            if (existing == null) registrations.insert(activityId, userId);
            else registrations.changeStatus(existing.id(), "ACTIVE");
        } else if (existing == null) {
            registrations.insertWaiting(activityId, userId);
        } else {
            // Rejoining after cancellation while full appends the user to the queue by refreshing updated_at.
            registrations.changeStatus(existing.id(), "WAITING");
        }
        return activityService.get(activityId, userId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView cancel(long activityId, long userId) {
        lockOpenActivity(activityId);
        RegistrationRow existing = registrations.findByActivityAndUser(activityId, userId);
        if (existing != null && existing.status().equals("ACTIVE")) {
            registrations.changeStatus(existing.id(), "CANCELLED");
            activities.changeRegisteredCount(activityId, -1);
            RegistrationRow waiting = registrations.findEarliestWaiting(activityId);
            if (waiting != null) {
                registrations.changeStatus(waiting.id(), "ACTIVE");
                activities.changeRegisteredCount(activityId, 1);
            }
        } else if (existing != null && existing.status().equals("WAITING")) {
            registrations.changeStatus(existing.id(), "CANCELLED");
        }
        return activityService.get(activityId, userId);
    }

    @Transactional(readOnly = true)
    public List<RegistrationView> mine(long userId) {
        return registrations.findByUser(userId).stream()
            .map(row -> new RegistrationView(row.id(), row.status(), activityService.get(row.activityId(), userId))).toList();
    }

    private ActivityRow lockOpenActivity(long activityId) {
        ActivityRow activity = activities.lockById(activityId);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        // Check after acquiring the lock: a request waiting for a seat may cross the start time.
        if (!activity.startsAt().toInstant(ZoneOffset.UTC).isAfter(clock.instant())) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CLOSED", "活动已开始，报名和取消已关闭");
        }
        return activity;
    }
}

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
        // Check existing state before capacity: retrying an existing success remains successful even when full.
        if (existing != null && existing.status().equals("ACTIVE")) return activityService.get(activityId, userId);
        if (activity.registeredCount() >= activity.capacity()) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_FULL", "活动名额已满");
        }
        activities.changeRegisteredCount(activityId, 1);
        if (existing == null) registrations.insert(activityId, userId);
        else registrations.changeStatus(existing.id(), "ACTIVE");
        return activityService.get(activityId, userId);
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView cancel(long activityId, long userId) {
        lockOpenActivity(activityId);
        RegistrationRow existing = registrations.findByActivityAndUser(activityId, userId);
        if (existing != null && existing.status().equals("ACTIVE")) {
            registrations.changeStatus(existing.id(), "CANCELLED");
            activities.changeRegisteredCount(activityId, -1);
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

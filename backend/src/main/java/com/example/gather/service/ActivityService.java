package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.*;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.ActivityMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;

@Service
public class ActivityService {
    private final ActivityMapper activities;
    private final Clock clock;

    public ActivityService(ActivityMapper activities, Clock clock) {
        this.activities = activities;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ActivityView> list(Long userId) {
        var now = clock.instant();
        return activities.findAll(userId).stream().map(row -> ActivityView.from(row, now)).toList();
    }

    @Transactional(readOnly = true)
    public ActivityView get(long id, Long userId) {
        ActivityRow row = activities.findById(id, userId);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return ActivityView.from(row, clock.instant());
    }

    @Transactional
    public ActivityView create(CreateActivityRequest request, long creatorId) {
        if (!request.startsAt().isAfter(clock.instant())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "开始时间必须在未来");
        }
        NewActivity row = new NewActivity(request.title().strip(), request.description().strip(), request.location().strip(),
            LocalDateTime.ofInstant(request.startsAt(), ZoneOffset.UTC), request.capacity(), creatorId);
        activities.insert(row);
        return get(row.id, creatorId);
    }
}

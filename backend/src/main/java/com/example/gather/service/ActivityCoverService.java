package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.domain.ActivityCoverRow;
import com.example.gather.mapper.ActivityCoverMapper;
import com.example.gather.mapper.ActivityMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.Objects;

@Service
public class ActivityCoverService {
    private final ActivityMapper activities;
    private final ActivityCoverMapper covers;
    private final ActivityService activityViews;
    private final AuditLogService audit;
    private final Clock clock;

    public ActivityCoverService(ActivityMapper activities, ActivityCoverMapper covers, ActivityService activityViews,
                                AuditLogService audit, Clock clock) {
        this.activities = activities; this.covers = covers; this.activityViews = activityViews;
        this.audit = audit; this.clock = clock;
    }

    @Transactional(readOnly = true)
    public ActivityCoverRow get(long id) {
        var cover = covers.findById(id);
        if (cover == null) throw new ApiException(HttpStatus.NOT_FOUND, "COVER_NOT_FOUND", "活动封面不存在");
        return cover;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public ActivityView replace(long id, ActivityCoverImages.Prepared image, long adminId) {
        var activity = activities.lockById(id);
        if (activity == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        if (activity.cancelledAt() != null) throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CANCELLED", "活动已取消，不能编辑封面");
        var now = clock.instant();
        if (!activity.startsAt().toInstant(ZoneOffset.UTC).isAfter(now)) {
            throw new ApiException(HttpStatus.CONFLICT, "ACTIVITY_CLOSED", "活动已开始，不能编辑封面");
        }
        String before = covers.hash(id);
        String after = image == null ? null : image.hash();
        if (!Objects.equals(before, after)) {
            covers.replace(id, image == null ? null : image.bytes(), after);
            audit.coverEdited(id, adminId, before, after, now);
        }
        return activityViews.get(id, adminId);
    }
}

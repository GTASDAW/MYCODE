package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.AuditLogModels.*;
import com.example.gather.domain.ActivityAuditText;
import com.example.gather.domain.NewActivity;
import com.example.gather.mapper.AuditLogMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.Objects;
import java.math.BigDecimal;

@Service
public class AuditLogService {
    private static final Set<String> ACTIONS = Set.of("ALL", "CREATE", "EDIT", "CANCEL", "CHECK_IN");
    private final AuditLogMapper audit;
    private final ObjectMapper json;

    public AuditLogService(AuditLogMapper audit, ObjectMapper json) {
        this.audit = audit;
        this.json = json;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AuditLogPageView search(int page, int pageSize, String action, Long activityId) {
        if (page < 1 || pageSize < 1 || pageSize > 100 || action == null || !ACTIONS.contains(action)
            || activityId != null && activityId < 1) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "审计筛选不正确，页码至少为 1，每页数量应在 1 到 100 之间");
        }
        long total = audit.count(action, activityId);
        var items = audit.page(action, activityId, pageSize, ((long) page - 1) * pageSize).stream()
            .map(AuditLogView::from).toList();
        return new AuditLogPageView(items, total, page, pageSize);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AuditLogDetailView detail(long id) {
        var row = audit.findById(id);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "AUDIT_LOG_NOT_FOUND", "审计记录不存在");
        List<AuditChange> changes = json.readValue(audit.changes(id), new TypeReference<List<AuditChange>>() {});
        return AuditLogDetailView.from(row, changes);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void created(NewActivity activity, long actorId, Instant now) {
        append("CREATE", activity.id, actorId, null, List.of(
            new AuditChange("title", null, activity.title),
            new AuditChange("description", null, activity.description),
            new AuditChange("location", null, activity.location),
            new AuditChange("startsAt", null, activity.startsAt.toInstant(ZoneOffset.UTC).toString()),
            new AuditChange("endsAt", null, activity.endsAt == null ? null : activity.endsAt.toInstant(ZoneOffset.UTC).toString()),
            new AuditChange("registrationDeadline", null, activity.registrationDeadline == null ? null : activity.registrationDeadline.toInstant(ZoneOffset.UTC).toString()),
            new AuditChange("capacity", null, Integer.toString(activity.capacity)),
            new AuditChange("category", null, activity.category),
            new AuditChange("locationLongitude", null, coordinate(activity.locationLongitude)),
            new AuditChange("locationLatitude", null, coordinate(activity.locationLatitude))), utc(now));
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void edited(long activityId, long actorId, ActivityAuditText before,
                        String title, String description, String location, String category, Instant now) {
        edited(activityId, actorId, before, title, description, location, category, before.locationLongitude(), before.locationLatitude(), now);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void edited(long activityId, long actorId, ActivityAuditText before,
                        String title, String description, String location, String category,
                        BigDecimal longitude, BigDecimal latitude, Instant now) {
        List<AuditChange> changes = new ArrayList<>();
        if (!before.title().equals(title)) changes.add(new AuditChange("title", before.title(), title));
        if (!before.description().equals(description)) changes.add(new AuditChange("description", before.description(), description));
        if (!before.location().equals(location)) changes.add(new AuditChange("location", before.location(), location));
        if (!before.category().equals(category)) changes.add(new AuditChange("category", before.category(), category));
        if (!Objects.equals(before.locationLongitude(), longitude))
            changes.add(new AuditChange("locationLongitude", coordinate(before.locationLongitude()), coordinate(longitude)));
        if (!Objects.equals(before.locationLatitude(), latitude))
            changes.add(new AuditChange("locationLatitude", coordinate(before.locationLatitude()), coordinate(latitude)));
        if (!changes.isEmpty()) append("EDIT", activityId, actorId, null, changes, utc(now));
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void coverEdited(long activityId, long actorId, String before, String after, Instant now) {
        append("EDIT", activityId, actorId, null, List.of(new AuditChange("coverHash", before, after)), utc(now));
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void cancelled(long activityId, long actorId, String reason, LocalDateTime now) {
        append("CANCEL", activityId, actorId, null, List.of(
            new AuditChange("cancelledAt", null, now.toInstant(ZoneOffset.UTC).toString()),
            new AuditChange("cancellationReason", null, reason)), now);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void checkedIn(long activityId, long actorId, long registrationId, LocalDateTime now) {
        append("CHECK_IN", activityId, actorId, registrationId,
            List.of(new AuditChange("checkedInAt", null, now.toInstant(ZoneOffset.UTC).toString())), now);
    }

    private void append(String action, long activityId, long actorId, Long registrationId, List<AuditChange> changes, LocalDateTime now) {
        // Only typed, explicitly whitelisted business fields reach persistence; never a request body or Session snapshot.
        var context = audit.context(activityId, actorId, registrationId);
        if (context == null || registrationId != null && context.targetUsername() == null) {
            throw new IllegalStateException("Audit context is missing from the owning transaction");
        }
        if (audit.insert(action, activityId, actorId, registrationId, context, now, json.writeValueAsString(changes)) != 1) {
            throw new IllegalStateException("Audit event was not saved");
        }
    }

    private static LocalDateTime utc(Instant now) {
        return LocalDateTime.ofInstant(now.truncatedTo(ChronoUnit.MICROS), ZoneOffset.UTC);
    }

    private static String coordinate(BigDecimal value) { return value == null ? null : value.toPlainString(); }
}

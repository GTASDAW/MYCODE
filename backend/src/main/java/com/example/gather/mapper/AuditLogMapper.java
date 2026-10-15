package com.example.gather.mapper;

import com.example.gather.domain.AuditLogContext;
import com.example.gather.domain.AuditLogRow;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AuditLogMapper {
    String METADATA = "id, action, activity_id, activity_title, actor_user_id, actor_username, actor_display_name, "
        + "registration_id, target_username, target_display_name, occurred_at";
    String FILTER = """
        WHERE 1=1
        <if test="action != 'ALL'">AND action=#{action}</if>
        <if test="activityId != null">AND activity_id=#{activityId}</if>
        """;

    @Select("<script>SELECT COUNT(*) FROM activity_audit_logs " + FILTER + "</script>")
    long count(@Param("action") String action, @Param("activityId") Long activityId);

    @Select("<script>SELECT " + METADATA + " FROM activity_audit_logs " + FILTER
        + " ORDER BY occurred_at DESC, id DESC LIMIT #{limit} OFFSET #{offset}</script>")
    List<AuditLogRow> page(@Param("action") String action, @Param("activityId") Long activityId,
                          @Param("limit") int limit, @Param("offset") long offset);

    @Select("SELECT " + METADATA + " FROM activity_audit_logs WHERE id=#{id}")
    AuditLogRow findById(long id);

    @Select("SELECT changes_json FROM activity_audit_logs WHERE id=#{id}")
    String changes(long id);

    @Select("""
        SELECT a.title AS activity_title, actor.username AS actor_username, actor.display_name AS actor_display_name,
               target.username AS target_username, target.display_name AS target_display_name
        FROM activities a JOIN users actor ON actor.id=#{actorId}
        LEFT JOIN registrations r ON r.id=#{registrationId} AND r.activity_id=a.id
        LEFT JOIN users target ON target.id=r.user_id
        WHERE a.id=#{activityId}
        """)
    AuditLogContext context(@Param("activityId") long activityId, @Param("actorId") long actorId,
                             @Param("registrationId") Long registrationId);

    @Insert("""
        INSERT INTO activity_audit_logs(action, activity_id, activity_title, actor_user_id, actor_username,
            actor_display_name, registration_id, target_username, target_display_name, occurred_at, changes_json)
        VALUES(#{action}, #{activityId}, #{context.activityTitle}, #{actorId}, #{context.actorUsername},
            #{context.actorDisplayName}, #{registrationId}, #{context.targetUsername}, #{context.targetDisplayName},
            #{occurredAt}, #{changesJson})
        """)
    int insert(@Param("action") String action, @Param("activityId") long activityId, @Param("actorId") long actorId,
               @Param("registrationId") Long registrationId, @Param("context") AuditLogContext context,
               @Param("occurredAt") LocalDateTime occurredAt, @Param("changesJson") String changesJson);
}

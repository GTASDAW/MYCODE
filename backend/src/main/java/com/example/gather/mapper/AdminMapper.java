package com.example.gather.mapper;

import com.example.gather.api.AdminModels.OverviewView;
import com.example.gather.api.AdminModels.RosterSummaryView;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.RosterRow;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AdminMapper {
    // One statement and one supplied UTC time keep all indicators on the same database snapshot.
    // Count registrations separately rather than joining and multiplying activity totals/capacities.
    @Select("""
        SELECT COUNT(*) AS total_activities,
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at > #{now} THEN 1 ELSE 0 END), 0) AS upcoming_activities,
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at <= #{now} THEN 1 ELSE 0 END), 0) AS started_activities,
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at > #{now} AND (registration_deadline IS NULL OR registration_deadline > #{now}) AND registered_count = capacity THEN 1 ELSE 0 END), 0) AS full_activities,
               (SELECT COUNT(*) FROM registrations WHERE status = 'ACTIVE') AS active_registrations,
               (SELECT COUNT(*) FROM registrations WHERE status = 'WAITING') AS waiting_registrations,
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at > #{now} AND (registration_deadline IS NULL OR registration_deadline > #{now}) THEN capacity - registered_count ELSE 0 END), 0) AS available_seats,
               COALESCE(SUM(CASE WHEN cancelled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS cancelled_activities
        FROM activities
        """)
    OverviewView overview(LocalDateTime now);

    @Select("<script>SELECT " + ActivityMapper.VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id = a.id AND r.user_id = #{userId} "
        + ActivityQuerySql.FILTER + " ORDER BY a.starts_at ASC, a.id ASC LIMIT #{limit} OFFSET #{offset}</script>")
    List<ActivityRow> activities(@Param("userId") long userId, @Param("now") LocalDateTime now,
                                @Param("keyword") String keyword, @Param("status") String status, @Param("category") String category,
                                @Param("startFromUtc") LocalDateTime startFromUtc, @Param("startUntilUtc") LocalDateTime startUntilUtc,
                                @Param("limit") int limit, @Param("offset") long offset);

    @Select("<script>SELECT COUNT(*) FROM activities a " + ActivityQuerySql.FILTER + "</script>")
    long countActivities(@Param("now") LocalDateTime now, @Param("keyword") String keyword, @Param("status") String status,
                         @Param("category") String category, @Param("startFromUtc") LocalDateTime startFromUtc,
                         @Param("startUntilUtc") LocalDateTime startUntilUtc);

    String ROSTER_FILTER = """
        WHERE r.activity_id = #{activityId}
        <if test="keyword != ''">AND (LOCATE(#{keyword}, u.username) &gt; 0 OR LOCATE(#{keyword}, u.display_name) &gt; 0)</if>
        <if test="status != 'ALL'">AND r.status = #{status}</if>
        <if test="checkInStatus == 'CHECKED_IN'">AND r.status = 'ACTIVE' AND r.checked_in_at IS NOT NULL</if>
        <if test="checkInStatus == 'NOT_CHECKED_IN'">AND r.status = 'ACTIVE' AND r.checked_in_at IS NULL</if>
        """;

    String ROSTER_SELECT = """
        SELECT r.id, r.user_id, u.username, u.display_name, r.status, r.created_at, r.updated_at,
               r.checked_in_at, r.checked_in_by, checker.display_name AS checked_in_by_display_name, r.check_in_method, r.check_in_version
        FROM registrations r JOIN users u ON u.id = r.user_id
        LEFT JOIN users checker ON checker.id = r.checked_in_by
        """;

    @Select("<script>" + ROSTER_SELECT + ROSTER_FILTER + " ORDER BY r.updated_at DESC, r.id DESC LIMIT #{limit} OFFSET #{offset}</script>")
    List<RosterRow> roster(@Param("activityId") long activityId, @Param("status") String status,
                          @Param("checkInStatus") String checkInStatus, @Param("keyword") String keyword,
                          @Param("limit") int limit, @Param("offset") long offset);

    @Select("<script>SELECT COUNT(*) FROM registrations r JOIN users u ON u.id=r.user_id " + ROSTER_FILTER + "</script>")
    long countRoster(@Param("activityId") long activityId, @Param("status") String status,
                     @Param("checkInStatus") String checkInStatus, @Param("keyword") String keyword);

    @Select("""
        SELECT COUNT(*) AS active_registrations,
               COALESCE(SUM(checked_in_at IS NOT NULL), 0) AS checked_in_registrations,
               COALESCE(SUM(checked_in_at IS NULL), 0) AS not_checked_in_registrations
        FROM registrations WHERE activity_id=#{activityId} AND status='ACTIVE'
        """)
    RosterSummaryView rosterSummary(long activityId);

    @Select(ROSTER_SELECT + " WHERE r.activity_id=#{activityId} AND r.id=#{registrationId}")
    RosterRow findRosterRegistration(@Param("activityId") long activityId, @Param("registrationId") long registrationId);

    // The caller holds the parent activity lock. Preserve registration status, queue order and update time.
    @Update("UPDATE registrations SET checked_in_at=#{checkedInAt}, checked_in_by=#{adminId}, check_in_method='ADMIN', check_in_version=check_in_version+1 WHERE id=#{registrationId} AND checked_in_at IS NULL")
    int checkIn(@Param("registrationId") long registrationId, @Param("checkedInAt") LocalDateTime checkedInAt,
                @Param("adminId") long adminId);

    @Update("UPDATE registrations SET checked_in_at=NULL, checked_in_by=NULL, check_in_method=NULL, check_in_version=check_in_version+1 WHERE id=#{registrationId} AND checked_in_at IS NOT NULL")
    int revokeCheckIn(long registrationId);
}

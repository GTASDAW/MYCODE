package com.example.gather.mapper;

import com.example.gather.api.AdminModels.OverviewView;
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
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at > #{now} AND registered_count = capacity THEN 1 ELSE 0 END), 0) AS full_activities,
               (SELECT COUNT(*) FROM registrations WHERE status = 'ACTIVE') AS active_registrations,
               (SELECT COUNT(*) FROM registrations WHERE status = 'WAITING') AS waiting_registrations,
               COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND starts_at > #{now} THEN capacity - registered_count ELSE 0 END), 0) AS available_seats,
               COALESCE(SUM(CASE WHEN cancelled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS cancelled_activities
        FROM activities
        """)
    OverviewView overview(LocalDateTime now);

    @Select("<script>SELECT " + ActivityMapper.VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id = a.id AND r.user_id = #{userId} "
        + ActivityQuerySql.FILTER + " ORDER BY a.starts_at ASC, a.id ASC LIMIT #{limit} OFFSET #{offset}</script>")
    List<ActivityRow> activities(@Param("userId") long userId, @Param("now") LocalDateTime now,
                                @Param("keyword") String keyword, @Param("status") String status,
                                @Param("limit") int limit, @Param("offset") long offset);

    @Select("<script>SELECT COUNT(*) FROM activities a " + ActivityQuerySql.FILTER + "</script>")
    long countActivities(@Param("now") LocalDateTime now, @Param("keyword") String keyword, @Param("status") String status);

    String ROSTER_FILTER = """
        WHERE r.activity_id = #{activityId}
        <if test="status != 'ALL'">AND r.status = #{status}</if>
        """;

    @Select("""
        <script>
        SELECT r.id, r.user_id, u.username, u.display_name, r.status, r.created_at, r.updated_at
        FROM registrations r JOIN users u ON u.id = r.user_id
        """ + ROSTER_FILTER + " ORDER BY r.updated_at DESC, r.id DESC LIMIT #{limit} OFFSET #{offset}</script>")
    List<RosterRow> roster(@Param("activityId") long activityId, @Param("status") String status,
                          @Param("limit") int limit, @Param("offset") long offset);

    @Select("<script>SELECT COUNT(*) FROM registrations r " + ROSTER_FILTER + "</script>")
    long countRoster(@Param("activityId") long activityId, @Param("status") String status);
}

package com.example.gather.mapper;

import com.example.gather.domain.ActivityLockRow;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.ActivitySearchTotals;
import com.example.gather.domain.NewActivity;
import com.example.gather.domain.ActivityAuditText;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface ActivityMapper {
    String VIEW_COLUMNS = "a.id, a.title, a.description, a.location, a.starts_at, a.ends_at, a.registration_deadline, a.capacity, a.registered_count, "
        + WaitingQueueSql.COUNT + WaitingQueueSql.POSITION
        + "r.status AS registration_status, a.cancelled_at, a.cancellation_reason, a.category, a.cover_hash, a.location_longitude, a.location_latitude";

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} ORDER BY a.starts_at, a.id")
    List<ActivityRow> findAll(@Param("userId") Long userId);

    @Select("""
        <script>
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN a.cancelled_at IS NULL AND a.starts_at &gt; #{now} AND (a.registration_deadline IS NULL OR a.registration_deadline &gt; #{now}) THEN 1 ELSE 0 END), 0) AS upcoming_activities,
               COALESCE(SUM(CASE WHEN a.cancelled_at IS NULL AND a.starts_at &gt; #{now} AND (a.registration_deadline IS NULL OR a.registration_deadline &gt; #{now}) THEN a.capacity - a.registered_count ELSE 0 END), 0) AS available_seats
        FROM activities a
        """ + ActivityQuerySql.FILTER + "</script>")
    ActivitySearchTotals searchTotals(@Param("now") LocalDateTime now, @Param("keyword") String keyword,
                                      @Param("status") String status, @Param("category") String category,
                                      @Param("startFromUtc") LocalDateTime startFromUtc, @Param("startUntilUtc") LocalDateTime startUntilUtc);

    @Select("<script>SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} "
        + ActivityQuerySql.FILTER + " ORDER BY a.starts_at ASC, a.id ASC LIMIT #{limit} OFFSET #{offset}</script>")
    List<ActivityRow> search(@Param("userId") Long userId, @Param("now") LocalDateTime now,
                             @Param("keyword") String keyword, @Param("status") String status, @Param("category") String category,
                             @Param("startFromUtc") LocalDateTime startFromUtc, @Param("startUntilUtc") LocalDateTime startUntilUtc,
                             @Param("limit") int limit, @Param("offset") long offset);

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} WHERE a.id=#{id}")
    ActivityRow findById(@Param("id") long id, @Param("userId") Long userId);

    // Every registration mutation locks this row before reading registration state.
    // InnoDB serializes contenders for the same activity, keeping check + increment atomic.
    @Select("SELECT starts_at, registration_deadline, capacity, registered_count, cancelled_at FROM activities WHERE id=#{id} FOR UPDATE")
    ActivityLockRow lockById(long id);

    @Select("SELECT title, description, location, category, location_longitude, location_latitude FROM activities WHERE id=#{id}")
    ActivityAuditText auditText(long id);

    @Insert("INSERT INTO activities(title, description, location, starts_at, ends_at, registration_deadline, capacity, created_by, category, location_longitude, location_latitude) VALUES(#{title}, #{description}, #{location}, #{startsAt}, #{endsAt}, #{registrationDeadline}, #{capacity}, #{createdBy}, #{category}, #{locationLongitude}, #{locationLatitude})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(NewActivity activity);

    @Update("UPDATE activities SET registered_count=registered_count+#{delta} WHERE id=#{id}")
    int changeRegisteredCount(@Param("id") long id, @Param("delta") int delta);

    @Update("UPDATE activities SET title=#{title}, description=#{description}, location=#{location}, category=#{category}, location_longitude=#{longitude}, location_latitude=#{latitude} WHERE id=#{id}")
    int edit(@Param("id") long id, @Param("title") String title, @Param("description") String description,
             @Param("location") String location, @Param("category") String category,
             @Param("longitude") java.math.BigDecimal longitude, @Param("latitude") java.math.BigDecimal latitude);

    @Update("UPDATE activities SET registered_count=0, cancelled_at=#{cancelledAt}, cancellation_reason=#{reason}, cancelled_by=#{adminId} WHERE id=#{id}")
    int cancel(@Param("id") long id, @Param("cancelledAt") java.time.LocalDateTime cancelledAt,
               @Param("reason") String reason, @Param("adminId") long adminId);

    @Select("SELECT COUNT(*) FROM activities")
    int count();
}

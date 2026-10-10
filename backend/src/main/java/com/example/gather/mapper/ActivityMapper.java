package com.example.gather.mapper;

import com.example.gather.domain.ActivityLockRow;
import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.ActivitySearchTotals;
import com.example.gather.domain.NewActivity;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface ActivityMapper {
    String VIEW_COLUMNS = "a.id, a.title, a.description, a.location, a.starts_at, a.capacity, a.registered_count, "
        + "(SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=a.id AND rw.status='WAITING') AS waiting_count, "
        + "r.status AS registration_status, a.cancelled_at, a.cancellation_reason";

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} ORDER BY a.starts_at, a.id")
    List<ActivityRow> findAll(@Param("userId") Long userId);

    @Select("""
        <script>
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN a.cancelled_at IS NULL AND a.starts_at &gt; #{now} THEN 1 ELSE 0 END), 0) AS upcoming_activities,
               COALESCE(SUM(CASE WHEN a.cancelled_at IS NULL AND a.starts_at &gt; #{now} THEN a.capacity - a.registered_count ELSE 0 END), 0) AS available_seats
        FROM activities a
        """ + ActivityQuerySql.FILTER + "</script>")
    ActivitySearchTotals searchTotals(@Param("now") LocalDateTime now, @Param("keyword") String keyword,
                                      @Param("status") String status);

    @Select("<script>SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} "
        + ActivityQuerySql.FILTER + " ORDER BY a.starts_at ASC, a.id ASC LIMIT #{limit} OFFSET #{offset}</script>")
    List<ActivityRow> search(@Param("userId") Long userId, @Param("now") LocalDateTime now,
                             @Param("keyword") String keyword, @Param("status") String status,
                             @Param("limit") int limit, @Param("offset") long offset);

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} WHERE a.id=#{id}")
    ActivityRow findById(@Param("id") long id, @Param("userId") Long userId);

    // Every registration mutation locks this row before reading registration state.
    // InnoDB serializes contenders for the same activity, keeping check + increment atomic.
    @Select("SELECT starts_at, capacity, registered_count, cancelled_at FROM activities WHERE id=#{id} FOR UPDATE")
    ActivityLockRow lockById(long id);

    @Insert("INSERT INTO activities(title, description, location, starts_at, capacity, created_by) VALUES(#{title}, #{description}, #{location}, #{startsAt}, #{capacity}, #{createdBy})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(NewActivity activity);

    @Update("UPDATE activities SET registered_count=registered_count+#{delta} WHERE id=#{id}")
    int changeRegisteredCount(@Param("id") long id, @Param("delta") int delta);

    @Update("UPDATE activities SET title=#{title}, description=#{description}, location=#{location} WHERE id=#{id}")
    int edit(@Param("id") long id, @Param("title") String title, @Param("description") String description,
             @Param("location") String location);

    @Update("UPDATE activities SET registered_count=0, cancelled_at=#{cancelledAt}, cancellation_reason=#{reason}, cancelled_by=#{adminId} WHERE id=#{id}")
    int cancel(@Param("id") long id, @Param("cancelledAt") java.time.LocalDateTime cancelledAt,
               @Param("reason") String reason, @Param("adminId") long adminId);

    @Select("SELECT COUNT(*) FROM activities")
    int count();
}

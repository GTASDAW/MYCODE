package com.example.gather.mapper;

import com.example.gather.domain.AttendanceRow;
import com.example.gather.domain.AttendanceTotals;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface AttendanceMapper {
    String SOURCE = """
        FROM activities a
        LEFT JOIN registrations r ON r.activity_id=a.id AND r.status='ACTIVE'
        WHERE a.cancelled_at IS NULL AND a.starts_at >= #{fromUtc} AND a.starts_at < #{untilUtc}
              AND a.starts_at <= #{now}
        """;

    @Select("""
        SELECT COUNT(DISTINCT a.id) AS total_activities,
               COUNT(r.id) AS active_registrations, COUNT(r.checked_in_at) AS checked_in_registrations
        """ + SOURCE)
    AttendanceTotals totals(@Param("fromUtc") LocalDateTime fromUtc, @Param("untilUtc") LocalDateTime untilUtc,
                             @Param("now") LocalDateTime now);

    @Select("""
        SELECT a.id, a.title, a.location, a.starts_at, a.capacity,
               COUNT(r.id) AS active_registrations, COUNT(r.checked_in_at) AS checked_in_registrations
        """ + SOURCE + " GROUP BY a.id ORDER BY a.starts_at DESC, a.id DESC LIMIT #{limit} OFFSET #{offset}")
    List<AttendanceRow> page(@Param("fromUtc") LocalDateTime fromUtc, @Param("untilUtc") LocalDateTime untilUtc,
                             @Param("now") LocalDateTime now, @Param("limit") int limit, @Param("offset") long offset);
}

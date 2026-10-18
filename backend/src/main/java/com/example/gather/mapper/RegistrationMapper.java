package com.example.gather.mapper;

import com.example.gather.domain.RegistrationRow;
import com.example.gather.domain.MyRegistrationRow;
import com.example.gather.domain.MyRegistrationTotals;
import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface RegistrationMapper {
    String MY_VIEW_COLUMNS = "r.id AS registration_id, r.status, r.checked_in_at, "
        + "a.id AS activity_id, a.title, a.description, a.location, a.starts_at, a.ends_at, a.capacity, a.registered_count, "
        + "(SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=a.id AND rw.status='WAITING') AS waiting_count, "
        + "a.cancelled_at, a.cancellation_reason, a.category, a.cover_hash";

    // The activity row already serializes every mutation. Do not lock a missing registration:
    // under REPEATABLE READ that would take gap locks shared by unrelated activities.
    @Select("SELECT id, activity_id, user_id, status FROM registrations WHERE activity_id=#{activityId} AND user_id=#{userId}")
    RegistrationRow findByActivityAndUser(@Param("activityId") long activityId, @Param("userId") long userId);

    @Insert("INSERT INTO registrations(activity_id, user_id, status) VALUES(#{activityId}, #{userId}, 'ACTIVE')")
    int insert(@Param("activityId") long activityId, @Param("userId") long userId);

    @Insert("INSERT INTO registrations(activity_id, user_id, status) VALUES(#{activityId}, #{userId}, 'WAITING')")
    int insertWaiting(@Param("activityId") long activityId, @Param("userId") long userId);

    @Update("UPDATE registrations SET status=#{status}, updated_at=UTC_TIMESTAMP(6) WHERE id=#{id}")
    int changeStatus(@Param("id") long id, @Param("status") String status);

    // The caller holds the activity row lock. Existing cancelled history must stay untouched.
    @Update("UPDATE registrations SET status='CANCELLED', updated_at=#{cancelledAt} WHERE activity_id=#{activityId} AND status IN ('ACTIVE', 'WAITING')")
    int cancelForActivity(@Param("activityId") long activityId,
                          @Param("cancelledAt") java.time.LocalDateTime cancelledAt);

    @Select("SELECT id, activity_id, user_id, status FROM registrations "
        + "WHERE activity_id=#{activityId} AND status='WAITING' "
        + "ORDER BY updated_at ASC, id ASC LIMIT 1")
    RegistrationRow findEarliestWaiting(@Param("activityId") long activityId);

    @Select("SELECT " + MY_VIEW_COLUMNS + " FROM registrations r JOIN activities a ON a.id=r.activity_id "
        + "WHERE r.user_id=#{userId} ORDER BY r.updated_at DESC, r.id DESC")
    List<MyRegistrationRow> findMine(@Param("userId") long userId);

    // The filter affects total only: all four summary counts always cover this user's complete history.
    @Select("""
        SELECT COALESCE(SUM(CASE WHEN #{status}='ALL' OR r.status=#{status} THEN 1 ELSE 0 END), 0) AS total,
               COALESCE(SUM(r.status='ACTIVE'), 0) AS active_registrations,
               COALESCE(SUM(r.status='WAITING'), 0) AS waiting_registrations,
               COALESCE(SUM(r.status='CANCELLED'), 0) AS cancelled_registrations,
               COALESCE(SUM(r.status='ACTIVE' AND r.checked_in_at IS NOT NULL), 0) AS checked_in_registrations
        FROM registrations r WHERE r.user_id=#{userId}
        """)
    MyRegistrationTotals mineTotals(@Param("userId") long userId, @Param("status") String status);

    @Select("SELECT " + MY_VIEW_COLUMNS + " FROM registrations r JOIN activities a ON a.id=r.activity_id "
        + "WHERE r.user_id=#{userId} AND (#{status}='ALL' OR r.status=#{status}) "
        + "ORDER BY r.updated_at DESC, r.id DESC LIMIT #{limit} OFFSET #{offset}")
    List<MyRegistrationRow> searchMine(@Param("userId") long userId, @Param("status") String status,
                                       @Param("limit") int limit, @Param("offset") long offset);
}

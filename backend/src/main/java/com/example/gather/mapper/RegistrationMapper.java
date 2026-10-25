package com.example.gather.mapper;

import com.example.gather.domain.RegistrationRow;
import com.example.gather.domain.MyRegistrationRow;
import com.example.gather.domain.MyRegistrationTotals;
import com.example.gather.domain.RegistrationCheckInRow;
import com.example.gather.domain.LocationCheckInPreflightRow;
import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface RegistrationMapper {
    String MY_VIEW_COLUMNS = "r.id AS registration_id, r.status, r.checked_in_at, r.check_in_method, r.check_in_version, "
        + "a.id AS activity_id, a.title, a.description, a.location, a.starts_at, a.ends_at, a.registration_deadline, a.capacity, a.registered_count, "
        + WaitingQueueSql.COUNT + WaitingQueueSql.POSITION
        + "a.cancelled_at, a.cancellation_reason, a.category, a.cover_hash, a.location_longitude, a.location_latitude";
    String MY_SEARCH_MATCH = "(#{status}='ALL' OR r.status=#{status}) "
        + "AND (#{keyword}='' OR LOCATE(#{keyword}, a.title)>0 OR LOCATE(#{keyword}, a.location)>0)";

    // The activity row already serializes every mutation. Do not lock a missing registration:
    // under REPEATABLE READ that would take gap locks shared by unrelated activities.
    @Select("SELECT id, activity_id, user_id, status FROM registrations WHERE activity_id=#{activityId} AND user_id=#{userId}")
    RegistrationRow findByActivityAndUser(@Param("activityId") long activityId, @Param("userId") long userId);

    @Select("SELECT id, activity_id, user_id, status, checked_in_at, check_in_method, check_in_version FROM registrations WHERE id=#{id} AND user_id=#{userId}")
    RegistrationCheckInRow findMineCheckIn(@Param("id") long id, @Param("userId") long userId);

    @Select("SELECT r.id, r.activity_id, r.user_id, r.status, r.checked_in_at, r.check_in_version, "
        + "a.cancelled_at, a.ends_at, a.location_longitude, a.location_latitude "
        + "FROM registrations r JOIN activities a ON a.id=r.activity_id WHERE r.id=#{id} AND r.user_id=#{userId}")
    LocationCheckInPreflightRow findLocationCheckInPreflight(@Param("id") long id, @Param("userId") long userId);

    @Select("SELECT " + MY_VIEW_COLUMNS + " FROM registrations r JOIN activities a ON a.id=r.activity_id WHERE r.id=#{id} AND r.user_id=#{userId}")
    MyRegistrationRow findMineById(@Param("id") long id, @Param("userId") long userId);

    @Update("UPDATE registrations SET checked_in_at=#{now}, checked_in_by=NULL, check_in_method='SELF_LOCATION', check_in_version=check_in_version+1 WHERE id=#{id} AND check_in_version=#{expectedVersion} AND checked_in_at IS NULL AND status='ACTIVE'")
    int selfCheckIn(@Param("id") long id, @Param("now") java.time.LocalDateTime now, @Param("expectedVersion") long expectedVersion);

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

    // Status and keyword affect total only: all summary counts cover this user's complete history.
    @Select("SELECT COALESCE(SUM(CASE WHEN " + MY_SEARCH_MATCH + " THEN 1 ELSE 0 END), 0) AS total, " + """
               COALESCE(SUM(r.status='ACTIVE'), 0) AS active_registrations,
               COALESCE(SUM(r.status='WAITING'), 0) AS waiting_registrations,
               COALESCE(SUM(r.status='CANCELLED'), 0) AS cancelled_registrations,
               COALESCE(SUM(r.status='ACTIVE' AND r.checked_in_at IS NOT NULL), 0) AS checked_in_registrations
        FROM registrations r JOIN activities a ON a.id=r.activity_id WHERE r.user_id=#{userId}
        """)
    MyRegistrationTotals mineTotals(@Param("userId") long userId, @Param("status") String status,
                                    @Param("keyword") String keyword);

    @Select("SELECT " + MY_VIEW_COLUMNS + " FROM registrations r JOIN activities a ON a.id=r.activity_id "
        + "WHERE r.user_id=#{userId} AND " + MY_SEARCH_MATCH + " "
        + "ORDER BY r.updated_at DESC, r.id DESC LIMIT #{limit} OFFSET #{offset}")
    List<MyRegistrationRow> searchMine(@Param("userId") long userId, @Param("status") String status,
                                       @Param("keyword") String keyword,
                                       @Param("limit") int limit, @Param("offset") long offset);
}

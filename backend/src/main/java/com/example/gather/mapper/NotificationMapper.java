package com.example.gather.mapper;

import com.example.gather.domain.NotificationRow;
import org.apache.ibatis.annotations.*;
import java.time.LocalDateTime;
import java.util.List;

@Mapper
public interface NotificationMapper {
    String COLUMNS = "id, type, activity_id, activity_title, cancellation_reason, created_at, read_at";
    String STATUS_FILTER = "<if test=\"status == 'UNREAD'\"> AND read_at IS NULL</if>"
        + "<if test=\"status == 'READ'\"> AND read_at IS NOT NULL</if>";
    String TYPE_FILTER = "<if test=\"type != 'ALL'\"> AND type=#{type}</if>";

    @Select("SELECT COUNT(*) FROM notifications WHERE user_id=#{userId} AND read_at IS NULL")
    long unreadCount(long userId);

    @Select("<script>SELECT COUNT(*) FROM notifications WHERE user_id=#{userId}" + STATUS_FILTER + TYPE_FILTER + "</script>")
    long count(@Param("userId") long userId, @Param("status") String status, @Param("type") String type);

    @Select("<script>SELECT " + COLUMNS + " FROM notifications WHERE user_id=#{userId}" + STATUS_FILTER + TYPE_FILTER
        + " ORDER BY created_at DESC, id DESC LIMIT #{limit} OFFSET #{offset}</script>")
    List<NotificationRow> page(@Param("userId") long userId, @Param("status") String status, @Param("type") String type,
                               @Param("limit") int limit, @Param("offset") long offset);

    @Select("SELECT " + COLUMNS + " FROM notifications WHERE id=#{id} AND user_id=#{userId}")
    NotificationRow findOwned(@Param("id") long id, @Param("userId") long userId);

    @Update("UPDATE notifications SET read_at=GREATEST(created_at, #{now}) WHERE id=#{id} AND user_id=#{userId} AND read_at IS NULL")
    int markRead(@Param("id") long id, @Param("userId") long userId, @Param("now") LocalDateTime now);

    // Capture actual visible IDs: a timestamp or maximum ID can include an older uncommitted insert later.
    @Select("SELECT id FROM notifications WHERE user_id=#{userId} AND read_at IS NULL ORDER BY id ASC")
    List<Long> unreadIds(@Param("userId") long userId);

    // Scan primary-key ranges in the same order as other bulk requests, regardless of created_at ordering.
    @Update("<script>UPDATE notifications FORCE INDEX (PRIMARY) SET read_at=GREATEST(created_at, #{now}) "
        + "WHERE user_id=#{userId} AND read_at IS NULL AND id IN "
        + "<foreach collection=\"ids\" item=\"id\" open=\"(\" separator=\",\" close=\")\">#{id}</foreach> ORDER BY id ASC</script>")
    int markSelectedRead(@Param("userId") long userId, @Param("ids") List<Long> ids, @Param("now") LocalDateTime now);

    // The caller holds this activity's parent lock, and insertion shares its transaction.
    @Insert("INSERT INTO notifications(user_id, activity_id, type, activity_title, cancellation_reason, created_at) "
        + "SELECT #{userId}, id, 'PROMOTED', title, NULL, UTC_TIMESTAMP(6) FROM activities WHERE id=#{activityId}")
    int insertPromotion(@Param("activityId") long activityId, @Param("userId") long userId);

    // Capture the exact eligible recipient set before their registration states are cancelled.
    @Insert("INSERT INTO notifications(user_id, activity_id, type, activity_title, cancellation_reason, created_at) "
        + "SELECT r.user_id, a.id, 'ACTIVITY_CANCELLED', a.title, #{reason}, #{cancelledAt} "
        + "FROM activities a JOIN registrations r ON r.activity_id=a.id "
        + "WHERE a.id=#{activityId} AND r.status IN ('ACTIVE', 'WAITING')")
    int insertCancellation(@Param("activityId") long activityId, @Param("reason") String reason,
                           @Param("cancelledAt") LocalDateTime cancelledAt);
}

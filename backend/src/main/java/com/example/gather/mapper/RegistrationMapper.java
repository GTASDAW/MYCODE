package com.example.gather.mapper;

import com.example.gather.domain.RegistrationRow;
import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface RegistrationMapper {
    // The activity row already serializes every mutation. Do not lock a missing registration:
    // under REPEATABLE READ that would take gap locks shared by unrelated activities.
    @Select("SELECT id, activity_id, user_id, status FROM registrations WHERE activity_id=#{activityId} AND user_id=#{userId}")
    RegistrationRow findByActivityAndUser(@Param("activityId") long activityId, @Param("userId") long userId);

    @Insert("INSERT INTO registrations(activity_id, user_id, status) VALUES(#{activityId}, #{userId}, 'ACTIVE')")
    int insert(@Param("activityId") long activityId, @Param("userId") long userId);

    @Update("UPDATE registrations SET status=#{status}, updated_at=UTC_TIMESTAMP(6) WHERE id=#{id}")
    int changeStatus(@Param("id") long id, @Param("status") String status);

    @Select("SELECT id, activity_id, user_id, status FROM registrations WHERE user_id=#{userId} ORDER BY updated_at DESC, id DESC")
    List<RegistrationRow> findByUser(long userId);
}

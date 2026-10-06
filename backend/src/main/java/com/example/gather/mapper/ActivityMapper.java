package com.example.gather.mapper;

import com.example.gather.domain.ActivityRow;
import com.example.gather.domain.NewActivity;
import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface ActivityMapper {
    String VIEW_COLUMNS = "a.id, a.title, a.description, a.location, a.starts_at, a.capacity, a.registered_count, "
        + "(SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=a.id AND rw.status='WAITING') AS waiting_count, "
        + "r.status AS registration_status";

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} ORDER BY a.starts_at, a.id")
    List<ActivityRow> findAll(@Param("userId") Long userId);

    @Select("SELECT " + VIEW_COLUMNS + " FROM activities a LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} WHERE a.id=#{id}")
    ActivityRow findById(@Param("id") long id, @Param("userId") Long userId);

    // Every registration mutation locks this row before reading registration state.
    // InnoDB serializes contenders for the same activity, keeping check + increment atomic.
    @Select("SELECT id, title, description, location, starts_at, capacity, registered_count, "
        + "(SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=activities.id AND rw.status='WAITING') AS waiting_count, "
        + "NULL AS registration_status FROM activities WHERE id=#{id} FOR UPDATE")
    ActivityRow lockById(long id);

    @Insert("INSERT INTO activities(title, description, location, starts_at, capacity, created_by) VALUES(#{title}, #{description}, #{location}, #{startsAt}, #{capacity}, #{createdBy})")
    @Options(useGeneratedKeys = true, keyProperty = "id")
    int insert(NewActivity activity);

    @Update("UPDATE activities SET registered_count=registered_count+#{delta} WHERE id=#{id}")
    int changeRegisteredCount(@Param("id") long id, @Param("delta") int delta);

    @Select("SELECT COUNT(*) FROM activities")
    int count();
}

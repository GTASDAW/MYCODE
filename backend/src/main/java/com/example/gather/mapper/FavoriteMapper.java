package com.example.gather.mapper;

import com.example.gather.domain.FavoriteStateRow;
import com.example.gather.domain.FavoriteActivityRow;
import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface FavoriteMapper {
    @Select("SELECT a.id AS activity_id, f.created_at AS favorited_at FROM activities a "
        + "LEFT JOIN activity_favorites f ON f.activity_id=a.id AND f.user_id=#{userId} WHERE a.id=#{activityId}")
    FavoriteStateRow state(@Param("userId") long userId, @Param("activityId") long activityId);

    // The unique key serializes duplicate inserts; an existing bookmark keeps its original time.
    @Insert("INSERT INTO activity_favorites(user_id,activity_id,created_at) VALUES(#{userId},#{activityId},UTC_TIMESTAMP(6)) "
        + "ON DUPLICATE KEY UPDATE id=id")
    int insert(@Param("userId") long userId, @Param("activityId") long activityId);

    @Delete("DELETE FROM activity_favorites WHERE user_id=#{userId} AND activity_id=#{activityId}")
    int delete(@Param("userId") long userId, @Param("activityId") long activityId);

    @Select("SELECT COUNT(*) FROM activity_favorites WHERE user_id=#{userId}")
    long count(long userId);

    @Select("SELECT " + ActivityMapper.VIEW_COLUMNS + ", f.created_at AS favorited_at "
        + "FROM activity_favorites f JOIN activities a ON a.id=f.activity_id "
        + "LEFT JOIN registrations r ON r.activity_id=a.id AND r.user_id=#{userId} "
        + "WHERE f.user_id=#{userId} ORDER BY f.created_at DESC,f.id DESC LIMIT #{limit} OFFSET #{offset}")
    List<FavoriteActivityRow> page(@Param("userId") long userId, @Param("limit") int limit, @Param("offset") long offset);
}

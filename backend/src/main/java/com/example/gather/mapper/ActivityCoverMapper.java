package com.example.gather.mapper;

import com.example.gather.domain.ActivityCoverRow;
import org.apache.ibatis.annotations.*;

@Mapper
public interface ActivityCoverMapper {
    @Select("SELECT cover_image, cover_hash FROM activities WHERE id=#{id} AND cover_hash IS NOT NULL")
    ActivityCoverRow findById(long id);

    @Select("SELECT cover_hash FROM activities WHERE id=#{id}")
    String hash(long id);

    @Update("UPDATE activities SET cover_image=#{image,jdbcType=LONGVARBINARY}, cover_hash=#{hash,jdbcType=CHAR} WHERE id=#{id}")
    int replace(@Param("id") long id, @Param("image") byte[] image, @Param("hash") String hash);
}

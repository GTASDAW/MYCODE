package com.example.gather.mapper;

import com.example.gather.domain.UserAvatarRow;
import org.apache.ibatis.annotations.*;

@Mapper
public interface AvatarMapper {
    @Select("SELECT avatar_image, avatar_hash FROM users WHERE id=#{userId} AND avatar_hash IS NOT NULL")
    UserAvatarRow findByUserId(long userId);

    @Update("UPDATE users SET avatar_image=#{image,jdbcType=LONGVARBINARY}, avatar_hash=#{hash,jdbcType=CHAR} WHERE id=#{userId}")
    int replace(@Param("userId") long userId, @Param("image") byte[] image, @Param("hash") String hash);
}

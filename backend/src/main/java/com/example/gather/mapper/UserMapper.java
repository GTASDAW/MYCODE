package com.example.gather.mapper;

import com.example.gather.domain.UserRow;
import org.apache.ibatis.annotations.*;

@Mapper
public interface UserMapper {
    @Select("SELECT id, username, password_hash, display_name, role FROM users WHERE username = #{username}")
    UserRow findByUsername(String username);

    @Select("SELECT id, username, password_hash, display_name, role FROM users WHERE id = #{id}")
    UserRow findById(long id);

    @Update("UPDATE users SET display_name = #{displayName} WHERE id = #{id}")
    int updateDisplayName(@Param("id") long id, @Param("displayName") String displayName);

    @Insert("INSERT INTO users(username, password_hash, display_name, role) VALUES(#{username}, #{passwordHash}, #{displayName}, #{role})")
    int insert(@Param("username") String username, @Param("passwordHash") String passwordHash,
               @Param("displayName") String displayName, @Param("role") String role);
}

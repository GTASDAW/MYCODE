package com.example.gather.mapper;

import com.example.gather.domain.UserRow;
import org.apache.ibatis.annotations.*;

@Mapper
public interface UserMapper {
    @Select("SELECT id, username, password_hash, display_name, role FROM users WHERE username = #{username}")
    UserRow findByUsername(String username);

    @Insert("INSERT INTO users(username, password_hash, display_name, role) VALUES(#{username}, #{passwordHash}, #{displayName}, #{role})")
    int insert(@Param("username") String username, @Param("passwordHash") String passwordHash,
               @Param("displayName") String displayName, @Param("role") String role);
}

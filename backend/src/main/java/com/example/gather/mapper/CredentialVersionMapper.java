package com.example.gather.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Param;

/** Every trusted Session request reads only the current version; password hashes never enter this path. */
@Mapper
public interface CredentialVersionMapper {
    @Select("SELECT credential_version FROM users WHERE id=#{id}")
    Long findByUserId(@Param("id") long id);
}

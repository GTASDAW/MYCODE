package com.example.gather.mapper;

/** Public and administrator activity queries use the same literal search and state rules. */
final class ActivityQuerySql {
    private ActivityQuerySql() {}

    static final String FILTER = """
        <where>
          <if test="keyword != ''">
            AND (LOCATE(#{keyword}, a.title) &gt; 0 OR LOCATE(#{keyword}, a.location) &gt; 0)
          </if>
          <choose>
            <when test="status == 'OPEN'">AND a.cancelled_at IS NULL AND a.starts_at &gt; #{now} AND a.registered_count &lt; a.capacity</when>
            <when test="status == 'FULL'">AND a.cancelled_at IS NULL AND a.starts_at &gt; #{now} AND a.registered_count = a.capacity</when>
            <when test="status == 'STARTED'">AND a.cancelled_at IS NULL AND a.starts_at &lt;= #{now}</when>
            <when test="status == 'UPCOMING'">AND a.cancelled_at IS NULL AND a.starts_at &gt; #{now}</when>
            <when test="status == 'CANCELLED'">AND a.cancelled_at IS NOT NULL</when>
          </choose>
        </where>
        """;
}

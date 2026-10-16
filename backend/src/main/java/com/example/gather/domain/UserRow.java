package com.example.gather.domain;

public record UserRow(long id, String username, String passwordHash, String displayName, String role, long credentialVersion) {
    @org.apache.ibatis.annotations.AutomapConstructor
    public UserRow {}
    public UserRow(long id, String username, String passwordHash, String displayName, String role) {
        this(id, username, passwordHash, displayName, role, 0);
    }
}

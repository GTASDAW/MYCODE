package com.example.gather.domain;

import java.time.LocalDateTime;

public record RosterRow(long id, long userId, String username, String displayName, String status,
                        LocalDateTime createdAt, LocalDateTime updatedAt, LocalDateTime checkedInAt,
                        Long checkedInBy, String checkedInByDisplayName, String checkInMethod, long checkInVersion) {
    @org.apache.ibatis.annotations.AutomapConstructor
    public RosterRow {}
    public RosterRow(long id, long userId, String username, String displayName, String status,
                     LocalDateTime createdAt, LocalDateTime updatedAt, LocalDateTime checkedInAt,
                     Long checkedInBy, String checkedInByDisplayName) {
        this(id, userId, username, displayName, status, createdAt, updatedAt, checkedInAt, checkedInBy,
            checkedInByDisplayName, checkedInAt == null ? null : "ADMIN", 0);
    }
}

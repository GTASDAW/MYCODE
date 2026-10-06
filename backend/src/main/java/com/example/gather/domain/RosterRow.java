package com.example.gather.domain;

import java.time.LocalDateTime;

public record RosterRow(long id, long userId, String username, String displayName, String status,
                        LocalDateTime createdAt, LocalDateTime updatedAt) {}

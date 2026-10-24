package com.example.gather.domain;

import java.time.LocalDateTime;

public record RegistrationCheckInRow(long id, long activityId, long userId, String status,
                                     LocalDateTime checkedInAt, String checkInMethod, long checkInVersion) {}

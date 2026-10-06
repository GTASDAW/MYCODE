package com.example.gather.domain;

import java.time.LocalDateTime;

public record ActivityRow(long id, String title, String description, String location,
                          LocalDateTime startsAt, int capacity, int registeredCount, String registrationStatus) {}

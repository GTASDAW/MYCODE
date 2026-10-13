package com.example.gather.domain;

public record MyRegistrationTotals(long total, long activeRegistrations, long waitingRegistrations,
                                   long cancelledRegistrations, long checkedInRegistrations) {}

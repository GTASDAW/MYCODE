package com.example.gather.domain;

/** One aggregate statement counts all matching activities, independent of the requested page. */
public record ActivitySearchTotals(long total, long upcomingActivities, long availableSeats) {}

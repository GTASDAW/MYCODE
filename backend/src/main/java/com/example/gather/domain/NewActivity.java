package com.example.gather.domain;

import java.time.LocalDateTime;

/** Mutable insert model so MyBatis can write the generated primary key. */
public class NewActivity {
    public Long id;
    public final String title;
    public final String description;
    public final String location;
    public final LocalDateTime startsAt;
    public final int capacity;
    public final long createdBy;

    public NewActivity(String title, String description, String location, LocalDateTime startsAt,
                       int capacity, long createdBy) {
        this.title = title;
        this.description = description;
        this.location = location;
        this.startsAt = startsAt;
        this.capacity = capacity;
        this.createdBy = createdBy;
    }
}

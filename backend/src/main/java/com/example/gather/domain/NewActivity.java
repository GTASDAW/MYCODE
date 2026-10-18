package com.example.gather.domain;

import java.time.LocalDateTime;

/** Mutable insert model so MyBatis can write the generated primary key. */
public class NewActivity {
    public Long id;
    public final String title;
    public final String description;
    public final String location;
    public final LocalDateTime startsAt;
    public final LocalDateTime endsAt;
    public final int capacity;
    public final long createdBy;
    public final String category;

    public NewActivity(String title, String description, String location, LocalDateTime startsAt,
                       int capacity, long createdBy) {
        this(title, description, location, startsAt, capacity, createdBy, "UNCATEGORIZED");
    }

    public NewActivity(String title, String description, String location, LocalDateTime startsAt,
                       int capacity, long createdBy, String category) {
        this(title, description, location, startsAt, capacity, createdBy, category, null);
    }

    public NewActivity(String title, String description, String location, LocalDateTime startsAt,
                       int capacity, long createdBy, String category, LocalDateTime endsAt) {
        this.title = title;
        this.description = description;
        this.location = location;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.capacity = capacity;
        this.createdBy = createdBy;
        this.category = category;
    }
}

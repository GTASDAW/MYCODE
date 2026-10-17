package com.example.gather.service;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import java.util.Set;

/** Exact persisted category values; ALL exists only as a query filter. */
final class ActivityCategories {
    private static final Set<String> VALUES = Set.of("UNCATEGORIZED", "TECHNOLOGY", "SPORTS", "CULTURE", "OTHER");
    private ActivityCategories() {}

    static String value(String category) {
        if (category == null || !VALUES.contains(category)) invalid();
        return category;
    }

    static void filter(String category) { if (!"ALL".equals(category)) value(category); }
    private static void invalid() { throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "活动分类不正确"); }
}

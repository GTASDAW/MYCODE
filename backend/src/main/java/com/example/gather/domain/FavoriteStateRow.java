package com.example.gather.domain;

import java.time.LocalDateTime;

public record FavoriteStateRow(long activityId, LocalDateTime favoritedAt) {}

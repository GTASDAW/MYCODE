package com.example.gather.api;

import java.time.Instant;
import java.util.List;
import com.example.gather.api.ApiModels.ActivityView;

public final class FavoriteModels {
    private FavoriteModels() {}
    public record FavoriteState(boolean favorited, Instant favoritedAt) {}
    public record FavoriteItem(ActivityView activity, Instant favoritedAt) {}
    public record FavoritePage(List<FavoriteItem> items, long total, int page, int pageSize) {}
}

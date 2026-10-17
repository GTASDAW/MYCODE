package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.api.FavoriteModels.*;
import com.example.gather.domain.FavoriteStateRow;
import com.example.gather.mapper.FavoriteMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.time.Clock;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

@Service
public class FavoriteService {
    private final FavoriteMapper favorites;
    private final Clock clock;
    public FavoriteService(FavoriteMapper favorites, Clock clock) { this.favorites = favorites; this.clock = clock; }

    @Transactional(readOnly = true)
    public FavoriteState state(long userId, long activityId) { return view(existing(userId, activityId)); }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public FavoriteState add(long userId, long activityId) {
        existing(userId, activityId);
        favorites.insert(userId, activityId);
        return view(existing(userId, activityId));
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public FavoriteState remove(long userId, long activityId) {
        existing(userId, activityId);
        favorites.delete(userId, activityId);
        return new FavoriteState(false, null);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public FavoritePage page(long userId, int page, int pageSize) {
        if (page < 1 || pageSize < 1 || pageSize > 100)
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "页码至少为 1，每页数量应在 1 到 100 之间");
        var now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        long total = favorites.count(userId);
        var items = favorites.page(userId, pageSize, ((long) page - 1) * pageSize).stream()
            .map(row -> new FavoriteItem(ActivityView.from(row.activity(), now), row.favoritedAt().toInstant(ZoneOffset.UTC))).toList();
        return new FavoritePage(items, total, page, pageSize);
    }

    private FavoriteStateRow existing(long userId, long activityId) {
        var row = favorites.state(userId, activityId);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "ACTIVITY_NOT_FOUND", "活动不存在");
        return row;
    }
    private static FavoriteState view(FavoriteStateRow row) {
        return new FavoriteState(row.favoritedAt() != null,
            row.favoritedAt() == null ? null : row.favoritedAt().toInstant(ZoneOffset.UTC));
    }
}

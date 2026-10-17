package com.example.gather.api;

import com.example.gather.api.FavoriteModels.*;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.FavoriteService;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/me/favorites")
public class FavoriteController {
    private final FavoriteService favorites;
    public FavoriteController(FavoriteService favorites) { this.favorites = favorites; }

    @GetMapping
    FavoritePage page(@RequestParam(required = false) String page, @RequestParam(required = false) String pageSize,
                      @AuthenticationPrincipal AppUserDetails principal) {
        return favorites.page(principal.id(), integer(page, 1), integer(pageSize, 10));
    }
    @GetMapping("/{activityId}")
    FavoriteState state(@PathVariable long activityId, @AuthenticationPrincipal AppUserDetails principal) {
        return favorites.state(principal.id(), activityId);
    }
    @PostMapping("/{activityId}")
    FavoriteState add(@PathVariable long activityId, @AuthenticationPrincipal AppUserDetails principal) {
        return favorites.add(principal.id(), activityId);
    }
    @DeleteMapping("/{activityId}")
    FavoriteState remove(@PathVariable long activityId, @AuthenticationPrincipal AppUserDetails principal) {
        return favorites.remove(principal.id(), activityId);
    }
    private static int integer(String text, int fallback) {
        if (text == null) return fallback;
        try {
            if (!text.matches("[0-9]+")) throw new NumberFormatException();
            return Integer.parseInt(text);
        } catch (NumberFormatException exception) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "页码和每页数量应为有效整数");
        }
    }
}

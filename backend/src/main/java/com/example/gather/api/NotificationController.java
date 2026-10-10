package com.example.gather.api;

import com.example.gather.api.NotificationModels.*;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.NotificationService;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/me/notifications")
public class NotificationController {
    private final NotificationService notifications;

    public NotificationController(NotificationService notifications) { this.notifications = notifications; }

    @GetMapping
    NotificationPageView page(@RequestParam(required = false) String page,
                              @RequestParam(required = false) String pageSize,
                              @RequestParam(required = false) String status,
                              @AuthenticationPrincipal AppUserDetails principal) {
        return notifications.page(principal.id(), integer(page, 1), integer(pageSize, 10), status == null ? "ALL" : status);
    }

    @GetMapping("/unread-count")
    UnreadCountView unreadCount(@AuthenticationPrincipal AppUserDetails principal) {
        return notifications.unreadCount(principal.id());
    }

    @PostMapping("/{id}/read")
    NotificationView read(@PathVariable long id, @AuthenticationPrincipal AppUserDetails principal) {
        return notifications.markRead(id, principal.id());
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

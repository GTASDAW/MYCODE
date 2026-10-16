package com.example.gather.api;

import com.example.gather.api.PasswordModels.ChangePasswordRequest;
import com.example.gather.security.AppUserDetails;
import com.example.gather.security.CurrentSessionLogout;
import com.example.gather.service.PasswordChangeService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api/me/password")
public class PasswordController {
    private final PasswordChangeService passwords;
    private final CurrentSessionLogout sessions;

    public PasswordController(PasswordChangeService passwords, CurrentSessionLogout sessions) { this.passwords = passwords; this.sessions = sessions; }

    @PostMapping
    Map<String, Boolean> change(@RequestBody ChangePasswordRequest body, @AuthenticationPrincipal AppUserDetails principal,
                                Authentication authentication, HttpServletRequest request, HttpServletResponse response) {
        // The proxied service has committed before logout begins; cleanup failure cannot undo the new password.
        passwords.change(principal, body);
        try { sessions.logout(request, response, authentication); }
        catch (RuntimeException unconfirmed) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "PASSWORD_CHANGE_UNCONFIRMED", "密码可能已更新，但退出确认失败，请重新登录验证");
        }
        return Map.of("success", true);
    }
}

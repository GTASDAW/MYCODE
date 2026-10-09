package com.example.gather.api;

import com.example.gather.api.AccountModels.UpdateProfileRequest;
import com.example.gather.api.ApiModels.UserView;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.AccountService;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/me")
public class ProfileController {
    private final AccountService accounts;

    public ProfileController(AccountService accounts) { this.accounts = accounts; }

    @PatchMapping("/profile")
    UserView profile(@RequestBody UpdateProfileRequest request, @AuthenticationPrincipal AppUserDetails principal) {
        return accounts.updateDisplayName(principal.id(), request.displayName());
    }
}

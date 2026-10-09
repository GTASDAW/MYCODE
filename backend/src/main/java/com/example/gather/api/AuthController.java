package com.example.gather.api;

import com.example.gather.api.ApiModels.CsrfView;
import com.example.gather.api.ApiModels.UserView;
import com.example.gather.api.AccountModels.RegisterRequest;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.AccountService;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AccountService accounts;

    public AuthController(AccountService accounts) { this.accounts = accounts; }

    @GetMapping("/csrf")
    CsrfView csrf(CsrfToken csrf) { return new CsrfView(csrf.getToken(), csrf.getHeaderName()); }

    @GetMapping("/me")
    UserView me(@AuthenticationPrincipal AppUserDetails principal) { return accounts.current(principal.id()); }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    UserView register(@RequestBody RegisterRequest request) { return accounts.register(request); }
}

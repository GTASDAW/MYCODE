package com.example.gather.api;

import com.example.gather.api.ApiModels.CsrfView;
import com.example.gather.api.ApiModels.UserView;
import com.example.gather.security.AppUserDetails;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    @GetMapping("/csrf")
    CsrfView csrf(CsrfToken csrf) { return new CsrfView(csrf.getToken(), csrf.getHeaderName()); }

    @GetMapping("/me")
    UserView me(@AuthenticationPrincipal AppUserDetails principal) { return principal.view(); }
}

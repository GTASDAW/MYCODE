package com.example.gather.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.stereotype.Component;

/** Revoke only the server Session/context: a late response must not erase a newly logged-in browser Cookie. */
@Component
public class CurrentSessionLogout {
    public static final String PRESERVE_BROWSER_COOKIE = CurrentSessionLogout.class.getName() + ".preserveBrowserCookie";
    private final SecurityContextLogoutHandler context = new SecurityContextLogoutHandler();

    public void logout(HttpServletRequest request, HttpServletResponse response, Authentication authentication) {
        // Spring Session commits outside the security chain and otherwise expires an invalidated Session Cookie.
        request.setAttribute(PRESERVE_BROWSER_COOKIE, Boolean.TRUE);
        context.logout(request, response, authentication);
    }
}

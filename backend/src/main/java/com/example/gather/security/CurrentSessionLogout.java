package com.example.gather.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.authentication.logout.SecurityContextLogoutHandler;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.DelegatingSecurityContextRepository;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.security.web.csrf.CsrfLogoutHandler;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.stereotype.Component;

/** Remove server authentication/CSRF while retaining the anonymous Session for already admitted concurrent requests. */
@Component
public class CurrentSessionLogout {
    private final SecurityContextLogoutHandler context = new SecurityContextLogoutHandler();
    private final CsrfLogoutHandler csrf = new CsrfLogoutHandler(new HttpSessionCsrfTokenRepository());

    public CurrentSessionLogout() {
        context.setInvalidateHttpSession(false);
        // Other admitted requests can still hold this old context; the database version rejects any later reuse.
        context.setClearAuthentication(false);
        context.setSecurityContextRepository(new DelegatingSecurityContextRepository(
            new RequestAttributeSecurityContextRepository(), new HttpSessionSecurityContextRepository()));
    }

    public void logout(HttpServletRequest request, HttpServletResponse response, Authentication authentication) {
        context.logout(request, response, authentication);
        csrf.logout(request, response, authentication);
    }
}

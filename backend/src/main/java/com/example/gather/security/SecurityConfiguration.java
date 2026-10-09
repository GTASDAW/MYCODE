package com.example.gather.security;

import com.example.gather.api.ApiModels.ErrorView;
import com.example.gather.monitoring.RequestObservationFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.savedrequest.NullRequestCache;
import tools.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Map;

@Configuration
public class SecurityConfiguration {
    @Bean
    PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(12); }

    @Bean
    SecurityFilterChain applicationSecurity(HttpSecurity http, ObjectMapper json) throws Exception {
        // The SPA asks /auth/csrf for a plain token and sends it through the returned header.
        // Spring Security rotates the token after successful login and logout.
        var tokens = new HttpSessionCsrfTokenRepository();
        var handler = new CsrfTokenRequestAttributeHandler();
        http.csrf(csrf -> csrf.csrfTokenRepository(tokens).csrfTokenRequestHandler(handler))
            .requestCache(cache -> cache.requestCache(new NullRequestCache()))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.GET, "/api/activities", "/api/activities/*", "/api/auth/csrf", "/api/health").permitAll()
                .requestMatchers("/api/auth/login").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/auth/register").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .exceptionHandling(errors -> errors
                .authenticationEntryPoint((request, response, exception) -> writeFailure(json, request, response, exception, 401,
                    new ErrorView("UNAUTHENTICATED", "请先登录")))
                .accessDeniedHandler((request, response, exception) -> writeFailure(json, request, response, exception, 403,
                    new ErrorView(exception instanceof CsrfException ? "CSRF_INVALID" : "FORBIDDEN",
                        exception instanceof CsrfException ? "安全凭证已失效，请刷新后重试" : "没有执行此操作的权限"))))
            .formLogin(login -> login.loginProcessingUrl("/api/auth/login")
                .successHandler((request, response, authentication) -> write(json, response, 200,
                    ((AppUserDetails) authentication.getPrincipal()).view()))
                .failureHandler((request, response, exception) -> writeFailure(json, request, response, exception, 401,
                    new ErrorView("INVALID_CREDENTIALS", "用户名或密码不正确"))))
            .logout(logout -> logout.logoutUrl("/api/auth/logout").invalidateHttpSession(true)
                .deleteCookies("JSESSIONID")
                .logoutSuccessHandler((request, response, authentication) -> write(json, response, 200, Map.of("success", true))));
        return http.build();
    }

    private static void write(ObjectMapper json, HttpServletResponse response, int status, Object value) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        json.writeValue(response.getWriter(), value);
    }

    private static void writeFailure(ObjectMapper json, HttpServletRequest request, HttpServletResponse response,
                                     Exception exception, int status, Object value) throws IOException {
        request.setAttribute(RequestObservationFilter.EXCEPTION_ATTRIBUTE, exception.getClass().getName());
        write(json, response, status, value);
    }
}

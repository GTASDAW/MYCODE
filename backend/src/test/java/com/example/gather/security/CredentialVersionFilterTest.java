package com.example.gather.security;

import com.example.gather.domain.UserRow;
import com.example.gather.mapper.CredentialVersionMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import tools.jackson.databind.ObjectMapper;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class CredentialVersionFilterTest {
    private final CredentialVersionMapper versions = mock(CredentialVersionMapper.class);
    private final ObjectMapper json = new ObjectMapper();
    private final HttpSessionCsrfTokenRepository tokens = new HttpSessionCsrfTokenRepository();
    private final CredentialVersionFilter filter = new CredentialVersionFilter(versions, new CurrentSessionLogout(), json);
    @AfterEach void clear() { SecurityContextHolder.clearContext(); }

    @Test
    void anonymousRequestsDoNotReadAnyCredentialAndCurrentVersionUsesExactlyOneLookup() throws Exception {
        var called = new AtomicBoolean();
        filter.doFilter(request("/api/activities"), new MockHttpServletResponse(), (request, response) -> called.set(true));
        assertThat(called).isTrue(); verifyNoInteractions(versions);
        authenticate(4L); when(versions.findByUserId(42)).thenReturn(4L);
        filter.doFilter(request("/api/auth/me"), new MockHttpServletResponse(), (request, response) -> called.set(true));
        verify(versions, times(1)).findByUserId(42);
    }

    @Test
    void staleOrMissingVersionsInvalidateTheCurrentSessionAndReturn401() throws Exception {
        for (Long current : new Long[] {5L, null}) {
            authenticate(4L); when(versions.findByUserId(42)).thenReturn(current);
            var request = request("/api/auth/me"); var session = new MockHttpSession(); request.setSession(session);
            var response = new MockHttpServletResponse(); var called = new AtomicBoolean();
            filter.doFilter(request, response, (value, result) -> called.set(true));
            assertThat(called).isFalse(); assertThat(session.isInvalid()).isTrue();
            assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
            assertThat(response.getStatus()).isEqualTo(401);
            assertThat(json.readTree(response.getContentAsString()).get("code").asString()).isEqualTo("SESSION_REVOKED");
        }
    }

    @Test
    void oldSerializedPrincipalWithNullVersionFailsClosedEvenIfDatabaseStillAtZero() throws Exception {
        authenticate(null); when(versions.findByUserId(42)).thenReturn(0L);
        var response = new MockHttpServletResponse();
        filter.doFilter(request("/api/me/registrations"), response, (request, result) -> fail("Old principal must not enter business code"));
        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    void unknownAuthenticatedPrincipalCannotBypassVersionChecks() throws Exception {
        var generic = org.springframework.security.core.userdetails.User.withUsername("generic").password("unused").roles("ADMIN").build();
        SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(generic, null, generic.getAuthorities()));
        var request = request("/api/admin/overview"); var session = new MockHttpSession(); request.setSession(session);
        var response = new MockHttpServletResponse();
        filter.doFilter(request, response, (value, result) -> fail("Unknown authenticated identity must not enter business code"));
        assertThat(response.getStatus()).isEqualTo(401); assertThat(session.isInvalid()).isTrue();
        verifyNoInteractions(versions);
    }

    @Test
    void publicEncodedActivityRoutesDowngradeButStaleCsrfNeverCreatesSessionOrCookie() throws Exception {
        for (String path : new String[] {"/api/activities", "/api/activities/search", "/api/activities/42", "/api/activities/%73earch"}) {
            authenticate(4L); when(versions.findByUserId(42)).thenReturn(5L);
            var request = request(path); var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (value, result) -> assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull());
            assertThat(response.getStatus()).isEqualTo(200);
        }
        authenticate(4L);
        var request = request("/api/auth/csrf"); var response = new MockHttpServletResponse();
        var old = tokens.generateToken(request); tokens.saveToken(old, request, response);
        filter.doFilter(request, response, (value, result) -> fail("Stale CSRF request must not create a replacement anonymous Session"));
        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(request.getSession(false)).isNull();
        assertThat(response.getHeader("Set-Cookie")).isNull();
    }

    @Test
    void databaseFailureIs503WithoutLeakingOrContinuingProtectedOrPublicRequests() throws Exception {
        authenticate(4L);
        when(versions.findByUserId(42)).thenThrow(new DataAccessResourceFailureException("jdbc-secret-password-private"));
        for (String path : new String[] {"/api/auth/me", "/api/activities/search"}) {
            var response = new MockHttpServletResponse();
            filter.doFilter(request(path), response, (request, result) -> fail("Database failure must not bypass authentication"));
            assertThat(response.getStatus()).isEqualTo(503);
            assertThat(response.getContentAsString()).contains("AUTHENTICATION_UNAVAILABLE").doesNotContain("jdbc-secret-password-private");
        }
    }

    private static void authenticate(Long version) throws Exception {
        var principal = new AppUserDetails(new UserRow(42, "test", "hash", "测试用户", "USER", version == null ? 0 : version));
        if (version == null) { Field field = AppUserDetails.class.getDeclaredField("credentialVersion"); field.setAccessible(true); field.set(principal, null); }
        var authentication = UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities());
        SecurityContextHolder.getContext().setAuthentication(authentication);
    }
    private static MockHttpServletRequest request(String path) { return new MockHttpServletRequest("GET", path); }
}

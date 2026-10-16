package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.PasswordModels.ChangePasswordRequest;
import com.example.gather.mapper.UserMapper;
import com.example.gather.security.AppUserDetails;
import com.example.gather.security.PasswordPolicy;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import java.util.Objects;

@Service
public class PasswordChangeService {
    private final UserMapper users;
    private final PasswordEncoder encoder;

    public PasswordChangeService(UserMapper users, PasswordEncoder encoder) { this.users = users; this.encoder = encoder; }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void change(AppUserDetails principal, ChangePasswordRequest request) {
        PasswordPolicy.validateCurrent(request.currentPassword());
        // No FOR UPDATE: BCrypt runs outside a row lock. Hash and version come from one snapshot row.
        var existing = users.findById(principal.id());
        if (existing == null || principal.credentialVersion() == null
            || !Objects.equals(principal.credentialVersion(), existing.credentialVersion())) revoked();
        if (!encoder.matches(request.currentPassword(), existing.passwordHash())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "CURRENT_PASSWORD_INCORRECT", "当前密码不正确");
        }
        PasswordPolicy.validateNew(request.newPassword());
        if (encoder.matches(request.newPassword(), existing.passwordHash())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
        }
        String nextHash = encoder.encode(request.newPassword());
        if (users.changePassword(principal.id(), existing.credentialVersion(), nextHash) != 1) revoked();
    }

    private static void revoked() { throw new ApiException(HttpStatus.UNAUTHORIZED, "SESSION_REVOKED", "登录已失效，请重新登录"); }
}

package com.example.gather.security;

import com.example.gather.api.ApiException;
import org.springframework.http.HttpStatus;
import java.nio.charset.StandardCharsets;

/** Shared registration/new-password rules; entered passwords are never trimmed. */
public final class PasswordPolicy {
    private PasswordPolicy() {}

    public static void validateNew(String password) {
        if (password == null || password.length() < 8 || password.length() > 64
            || !password.chars().anyMatch(value -> value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z')
            || !password.chars().anyMatch(value -> value >= '0' && value <= '9')) {
            throw invalid("密码须为 8–64 位，且包含英文字母和数字");
        }
        if (password.getBytes(StandardCharsets.UTF_8).length > 72) throw invalid("密码过长，请减少字符数量。");
    }

    public static void validateCurrent(String password) {
        if (password == null || password.isEmpty() || password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw invalid("请填写当前密码，UTF-8 编码不得超过 72 字节");
        }
    }

    private static ApiException invalid(String message) { return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message); }
}

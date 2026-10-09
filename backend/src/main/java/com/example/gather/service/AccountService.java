package com.example.gather.service;

import com.example.gather.api.AccountModels.RegisterRequest;
import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.UserView;
import com.example.gather.domain.UserRow;
import com.example.gather.mapper.UserMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

@Service
public class AccountService {
    private static final Pattern USERNAME = Pattern.compile("[A-Za-z][A-Za-z0-9_]{2,31}");
    private final UserMapper users;
    private final PasswordEncoder encoder;

    public AccountService(UserMapper users, PasswordEncoder encoder) {
        this.users = users;
        this.encoder = encoder;
    }

    @Transactional
    public UserView register(RegisterRequest request) {
        String username = request.username() == null ? "" : request.username().strip();
        if (!USERNAME.matcher(username).matches()) {
            throw invalid("用户名须为 3–32 位，以英文字母开头，仅含英文字母、数字和下划线");
        }
        username = username.toLowerCase(Locale.ROOT);
        String password = request.password();
        if (password == null || password.length() < 8 || password.length() > 64
            || !password.chars().anyMatch(value -> value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z')
            || !password.chars().anyMatch(value -> value >= '0' && value <= '9')) {
            throw invalid("密码须为 8–64 位，且包含英文字母和数字");
        }
        if (password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw invalid("密码过长，请减少字符数量。");
        }
        String displayName = displayName(request.displayName());
        String hash = encoder.encode(password);
        try {
            // The unique constraint decides concurrent registrations; callers cannot choose a role.
            users.insert(username, hash, displayName, "USER");
        } catch (DuplicateKeyException duplicate) {
            throw new ApiException(HttpStatus.CONFLICT, "USERNAME_TAKEN", "用户名已被使用");
        }
        return UserView.from(users.findByUsername(username));
    }

    public UserView current(long userId) { return UserView.from(requireUser(userId)); }

    @Transactional
    public UserView updateDisplayName(long userId, String displayName) {
        String name = displayName(displayName);
        requireUser(userId);
        users.updateDisplayName(userId, name);
        return current(userId);
    }

    private UserRow requireUser(long id) {
        UserRow row = users.findById(id);
        if (row == null) throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED", "请先登录");
        return row;
    }

    private static String displayName(String value) {
        if (value != null && value.chars().anyMatch(character -> character < 32 || character >= 127 && character <= 159)) {
            throw invalid("昵称不能包含控制字符");
        }
        String name = value == null ? "" : value.strip();
        if (name.isEmpty() || name.length() > 40) throw invalid("昵称须为 1–40 位");
        return name;
    }

    private static ApiException invalid(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
    }
}

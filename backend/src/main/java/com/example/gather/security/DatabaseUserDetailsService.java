package com.example.gather.security;

import com.example.gather.domain.UserRow;
import com.example.gather.mapper.UserMapper;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;
import java.util.Locale;

@Service
public class DatabaseUserDetailsService implements UserDetailsService {
    private final UserMapper users;

    public DatabaseUserDetailsService(UserMapper users) { this.users = users; }

    @Override
    public UserDetails loadUserByUsername(String username) {
        String canonical = username == null ? "" : username.strip().toLowerCase(Locale.ROOT);
        UserRow row = users.findByUsername(canonical);
        // MySQL's accent-insensitive collation may match a different submitted
        // spelling. Only the canonical stored name may test this user's password.
        if (row == null || !row.username().strip().toLowerCase(Locale.ROOT).equals(canonical))
            throw new UsernameNotFoundException("Unknown user");
        return new AppUserDetails(row);
    }
}

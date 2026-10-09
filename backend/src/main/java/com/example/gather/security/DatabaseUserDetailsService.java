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
        UserRow row = users.findByUsername(username == null ? "" : username.strip().toLowerCase(Locale.ROOT));
        if (row == null) throw new UsernameNotFoundException("Unknown user");
        return new AppUserDetails(row);
    }
}

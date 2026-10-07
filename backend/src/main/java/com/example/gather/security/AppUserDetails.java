package com.example.gather.security;

import com.example.gather.api.ApiModels.UserView;
import com.example.gather.domain.UserRow;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.User;
import java.io.Serial;
import java.util.List;

public class AppUserDetails extends User {
    @Serial
    private static final long serialVersionUID = 1L;

    private final UserView view;

    public AppUserDetails(UserRow row) {
        super(row.username(), row.passwordHash(), List.of(new SimpleGrantedAuthority("ROLE_" + row.role())));
        this.view = UserView.from(row);
    }

    public UserView view() { return view; }
    public long id() { return view.id(); }
}

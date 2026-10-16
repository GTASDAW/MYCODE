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
    // Nullable intentionally: older serialized Sessions deserialize this new field as null and fail closed.
    private final Long credentialVersion;

    public AppUserDetails(UserRow row) {
        super(row.username(), row.passwordHash(), List.of(new SimpleGrantedAuthority("ROLE_" + row.role())));
        this.view = UserView.from(row);
        this.credentialVersion = row.credentialVersion();
    }

    public UserView view() { return view; }
    public long id() { return view.id(); }
    public Long credentialVersion() { return credentialVersion; }
}

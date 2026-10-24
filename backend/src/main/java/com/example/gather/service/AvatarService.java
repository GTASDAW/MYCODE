package com.example.gather.service;

import com.example.gather.api.ApiException;
import com.example.gather.api.ApiModels.UserView;
import com.example.gather.domain.UserAvatarRow;
import com.example.gather.mapper.AvatarMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AvatarService {
    private final AvatarMapper avatars;
    private final AccountService accounts;

    public AvatarService(AvatarMapper avatars, AccountService accounts) {
        this.avatars = avatars; this.accounts = accounts;
    }

    @Transactional(readOnly = true)
    public UserAvatarRow get(long userId) {
        var avatar = avatars.findByUserId(userId);
        if (avatar == null) throw new ApiException(HttpStatus.NOT_FOUND, "AVATAR_NOT_FOUND", "尚未设置头像");
        return avatar;
    }

    @Transactional
    public UserView replace(long userId, AvatarImages.Prepared image) {
        avatars.replace(userId, image == null ? null : image.bytes(), image == null ? null : image.hash());
        return accounts.current(userId);
    }
}

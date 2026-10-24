package com.example.gather.api;

import com.example.gather.api.ApiModels.UserView;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.AvatarImages;
import com.example.gather.service.AvatarService;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/me/avatar")
public class AvatarController {
    private final AvatarImages images;
    private final AvatarService avatars;

    public AvatarController(AvatarImages images, AvatarService avatars) {
        this.images = images; this.avatars = avatars;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    UserView upload(@RequestParam("file") MultipartFile file, @AuthenticationPrincipal AppUserDetails principal) {
        var prepared = images.prepare(file);
        return avatars.replace(principal.id(), prepared);
    }

    @DeleteMapping
    UserView remove(@AuthenticationPrincipal AppUserDetails principal) {
        return avatars.replace(principal.id(), null);
    }

    @GetMapping
    ResponseEntity<byte[]> get(@AuthenticationPrincipal AppUserDetails principal) {
        var avatar = avatars.get(principal.id());
        return ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG).cacheControl(CacheControl.noStore())
            .header("X-Content-Type-Options", "nosniff").body(avatar.avatarImage());
    }
}

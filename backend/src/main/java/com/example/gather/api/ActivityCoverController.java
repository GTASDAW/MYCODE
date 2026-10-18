package com.example.gather.api;

import com.example.gather.api.ApiModels.ActivityView;
import com.example.gather.security.AppUserDetails;
import com.example.gather.service.ActivityCoverImages;
import com.example.gather.service.ActivityCoverService;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api")
public class ActivityCoverController {
    private final ActivityCoverImages images;
    private final ActivityCoverService covers;

    public ActivityCoverController(ActivityCoverImages images, ActivityCoverService covers) {
        this.images = images; this.covers = covers;
    }

    @PostMapping(path = "/admin/activities/{id}/cover", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    ActivityView upload(@PathVariable long id, @RequestParam("file") MultipartFile file,
                        @AuthenticationPrincipal AppUserDetails principal) {
        var prepared = images.prepare(file);
        return covers.replace(id, prepared, principal.id());
    }

    @DeleteMapping("/admin/activities/{id}/cover")
    ActivityView remove(@PathVariable long id, @AuthenticationPrincipal AppUserDetails principal) {
        return covers.replace(id, null, principal.id());
    }

    @GetMapping("/activities/{id}/cover")
    ResponseEntity<byte[]> get(@PathVariable long id, WebRequest request) {
        var cover = covers.get(id);
        String etag = '"' + cover.coverHash() + '"';
        if (request.checkNotModified(etag)) {
            return ResponseEntity.status(304).cacheControl(CacheControl.noCache()).eTag(etag).build();
        }
        return ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG).cacheControl(CacheControl.noCache())
            .header("X-Content-Type-Options", "nosniff").eTag(etag).body(cover.coverImage());
    }
}

package com.example.gather.api;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

public final class AccountModels {
    private AccountModels() {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record RegisterRequest(String username, String password, String displayName) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record UpdateProfileRequest(String displayName) {}
}

package com.example.gather.api;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

public final class PasswordModels {
    private PasswordModels() {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ChangePasswordRequest(String currentPassword, String newPassword) {}
}

package com.example.gather.domain;

public record UserRow(long id, String username, String passwordHash, String displayName, String role) {}

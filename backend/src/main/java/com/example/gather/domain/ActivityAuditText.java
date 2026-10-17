package com.example.gather.domain;

/** Read only after taking the existing activity lock, outside its hot registration projection. */
public record ActivityAuditText(String title, String description, String location, String category) {}

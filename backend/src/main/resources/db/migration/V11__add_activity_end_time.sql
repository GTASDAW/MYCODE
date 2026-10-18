ALTER TABLE activities
    ADD COLUMN ends_at DATETIME(6) NULL,
    ADD CONSTRAINT chk_activity_end_time CHECK (ends_at IS NULL OR ends_at > starts_at);

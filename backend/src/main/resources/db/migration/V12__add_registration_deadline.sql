ALTER TABLE activities
    ADD COLUMN registration_deadline DATETIME(6) NULL,
    ADD CONSTRAINT chk_activity_registration_deadline CHECK (registration_deadline IS NULL OR registration_deadline < starts_at);

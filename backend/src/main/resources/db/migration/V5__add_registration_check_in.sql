ALTER TABLE registrations
    ADD COLUMN checked_in_at DATETIME(6) NULL COMMENT 'UTC',
    ADD COLUMN checked_in_by BIGINT NULL,
    ADD CONSTRAINT fk_registration_check_in_admin FOREIGN KEY (checked_in_by) REFERENCES users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT chk_registration_check_in CHECK (
        (checked_in_at IS NULL AND checked_in_by IS NULL)
        OR (checked_in_at IS NOT NULL AND checked_in_by IS NOT NULL AND status = 'ACTIVE')
    );

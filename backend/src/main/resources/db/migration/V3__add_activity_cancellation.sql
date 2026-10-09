-- Preserve activities and their registration history when the organizer cancels.
ALTER TABLE activities
    ADD COLUMN cancelled_at DATETIME(6) NULL COMMENT 'UTC',
    ADD COLUMN cancellation_reason VARCHAR(500) NULL,
    ADD COLUMN cancelled_by BIGINT NULL,
    ADD CONSTRAINT fk_activities_canceller FOREIGN KEY (cancelled_by) REFERENCES users(id),
    ADD CONSTRAINT chk_activity_cancellation CHECK (
        (cancelled_at IS NULL AND cancellation_reason IS NULL AND cancelled_by IS NULL)
        OR
        (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL AND cancelled_by IS NOT NULL
            AND CHAR_LENGTH(TRIM(cancellation_reason)) BETWEEN 1 AND 500 AND registered_count = 0)
    );

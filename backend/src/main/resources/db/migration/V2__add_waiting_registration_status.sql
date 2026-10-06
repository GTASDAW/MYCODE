-- Extend the registration state machine without changing already-applied V1.
ALTER TABLE registrations
    DROP CHECK chk_registration_status,
    ADD CONSTRAINT chk_registration_status CHECK (status IN ('ACTIVE', 'WAITING', 'CANCELLED'));

-- Promotion reads the oldest queued row for one activity while the activity row is locked.
CREATE INDEX idx_registrations_waiting
    ON registrations (activity_id, status, updated_at, id);

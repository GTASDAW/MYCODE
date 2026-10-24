ALTER TABLE registrations
    ADD COLUMN check_in_method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN check_in_version BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT chk_registration_check_in_version CHECK (check_in_version >= 0);

-- Preserve the original check-in time, administrator and registration queue timestamp.
UPDATE registrations SET check_in_method='ADMIN' WHERE checked_in_at IS NOT NULL;

ALTER TABLE registrations
    DROP CHECK chk_registration_check_in,
    ADD CONSTRAINT chk_registration_check_in CHECK ((
        (checked_in_at IS NULL AND checked_in_by IS NULL AND check_in_method IS NULL)
        OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='ADMIN' AND checked_in_by IS NOT NULL)
        OR (status='ACTIVE' AND checked_in_at IS NOT NULL AND check_in_method='SELF_LOCATION' AND checked_in_by IS NULL)
    ) IS TRUE);

ALTER TABLE activity_audit_logs
    DROP CHECK chk_audit_action,
    DROP CHECK chk_audit_target,
    ADD CONSTRAINT chk_audit_action CHECK (action IN ('CREATE', 'EDIT', 'CANCEL', 'CHECK_IN', 'CHECK_IN_REVOKE')),
    ADD CONSTRAINT chk_audit_target CHECK ((
        (action IN ('CHECK_IN', 'CHECK_IN_REVOKE') AND registration_id IS NOT NULL AND target_username IS NOT NULL AND target_display_name IS NOT NULL)
        OR (action NOT IN ('CHECK_IN', 'CHECK_IN_REVOKE') AND registration_id IS NULL AND target_username IS NULL AND target_display_name IS NULL)
    ) IS TRUE);

CREATE TABLE activity_audit_logs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(16) NOT NULL,
    activity_id BIGINT NOT NULL,
    activity_title VARCHAR(100) NOT NULL,
    actor_user_id BIGINT NOT NULL,
    actor_username VARCHAR(50) NOT NULL,
    actor_display_name VARCHAR(80) NOT NULL,
    registration_id BIGINT NULL,
    target_username VARCHAR(50) NULL,
    target_display_name VARCHAR(80) NULL,
    occurred_at DATETIME(6) NOT NULL COMMENT 'UTC',
    changes_json JSON NOT NULL,
    CONSTRAINT fk_audit_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE RESTRICT,
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_audit_registration FOREIGN KEY (registration_id) REFERENCES registrations(id) ON DELETE RESTRICT,
    CONSTRAINT chk_audit_action CHECK (action IN ('CREATE', 'EDIT', 'CANCEL', 'CHECK_IN')),
    CONSTRAINT chk_audit_target CHECK (
        (action = 'CHECK_IN' AND registration_id IS NOT NULL AND target_username IS NOT NULL AND target_display_name IS NOT NULL)
        OR (action <> 'CHECK_IN' AND registration_id IS NULL AND target_username IS NULL AND target_display_name IS NULL)
    ),
    CONSTRAINT chk_audit_changes CHECK (JSON_TYPE(changes_json) = 'ARRAY' AND JSON_LENGTH(changes_json) > 0),
    INDEX idx_audit_time (occurred_at DESC, id DESC),
    INDEX idx_audit_action_time (action, occurred_at DESC, id DESC),
    INDEX idx_audit_activity_time (activity_id, occurred_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

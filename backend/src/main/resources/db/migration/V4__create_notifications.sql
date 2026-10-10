CREATE TABLE notifications (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    activity_id BIGINT NOT NULL,
    type VARCHAR(30) NOT NULL,
    activity_title VARCHAR(100) NOT NULL,
    cancellation_reason VARCHAR(500) NULL,
    created_at DATETIME(6) NOT NULL COMMENT 'UTC',
    read_at DATETIME(6) NULL COMMENT 'UTC; first successful read',
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_notifications_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE RESTRICT,
    CONSTRAINT chk_notification_type CHECK (type IN ('PROMOTED', 'ACTIVITY_CANCELLED')),
    CONSTRAINT chk_notification_title CHECK (CHAR_LENGTH(TRIM(activity_title)) BETWEEN 1 AND 100),
    CONSTRAINT chk_notification_reason CHECK (
        (type = 'PROMOTED' AND cancellation_reason IS NULL)
        OR (type = 'ACTIVITY_CANCELLED' AND cancellation_reason IS NOT NULL
            AND CHAR_LENGTH(TRIM(cancellation_reason)) BETWEEN 1 AND 500)
    ),
    CONSTRAINT chk_notification_read_time CHECK (read_at IS NULL OR read_at >= created_at),
    INDEX idx_notifications_user_created (user_id, created_at DESC, id DESC),
    INDEX idx_notifications_user_read_created (user_id, read_at, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

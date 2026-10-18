ALTER TABLE activities
    ADD COLUMN cover_image MEDIUMBLOB NULL,
    ADD COLUMN cover_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT chk_activity_cover CHECK (
        (cover_image IS NULL AND cover_hash IS NULL)
        OR (cover_image IS NOT NULL AND cover_hash IS NOT NULL
            AND OCTET_LENGTH(cover_image) BETWEEN 1 AND 2097152
            AND REGEXP_LIKE(cover_hash, '^[0-9a-f]{64}$', 'c'))
    );

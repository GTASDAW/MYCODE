ALTER TABLE users
    ADD COLUMN avatar_image MEDIUMBLOB NULL,
    ADD COLUMN avatar_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD CONSTRAINT chk_user_avatar_pair CHECK ((
        (avatar_image IS NULL AND avatar_hash IS NULL)
        OR (avatar_image IS NOT NULL AND avatar_hash IS NOT NULL
            AND OCTET_LENGTH(avatar_image) BETWEEN 1 AND 2097152
            AND REGEXP_LIKE(avatar_hash, '^[0-9a-f]{64}$', 'c'))
    ) IS TRUE);

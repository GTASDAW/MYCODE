ALTER TABLE users
    ADD COLUMN credential_version BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT chk_user_credential_version CHECK (credential_version >= 0);

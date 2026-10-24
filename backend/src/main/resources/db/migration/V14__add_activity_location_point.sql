ALTER TABLE activities
    ADD COLUMN location_longitude DECIMAL(10,7) NULL,
    ADD COLUMN location_latitude DECIMAL(9,7) NULL,
    ADD CONSTRAINT chk_activity_location_point CHECK (
        ((location_longitude IS NULL AND location_latitude IS NULL)
         OR (location_longitude IS NOT NULL AND location_latitude IS NOT NULL
             AND location_longitude BETWEEN -180 AND 180
             AND location_latitude BETWEEN -90 AND 90)) IS TRUE
    );

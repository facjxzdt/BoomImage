ALTER TABLE images ADD COLUMN storage_driver TEXT NOT NULL DEFAULT 'local' CHECK (storage_driver IN ('local', 's3'));
ALTER TABLE images ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'direct' CHECK (access_mode IN ('direct', 'proxy'));

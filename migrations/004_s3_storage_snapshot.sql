ALTER TABLE images ADD COLUMN s3_bucket TEXT;
ALTER TABLE images ADD COLUMN s3_object_key TEXT;
ALTER TABLE images ADD COLUMN s3_endpoint TEXT;
ALTER TABLE images ADD COLUMN s3_region TEXT;
ALTER TABLE images ADD COLUMN s3_public_base_url TEXT;
ALTER TABLE images ADD COLUMN s3_force_path_style INTEGER CHECK (s3_force_path_style IS NULL OR s3_force_path_style IN (0, 1));

ALTER TABLE variants ADD COLUMN s3_bucket TEXT;
ALTER TABLE variants ADD COLUMN s3_object_key TEXT;
ALTER TABLE variants ADD COLUMN s3_endpoint TEXT;
ALTER TABLE variants ADD COLUMN s3_region TEXT;
ALTER TABLE variants ADD COLUMN s3_public_base_url TEXT;
ALTER TABLE variants ADD COLUMN s3_force_path_style INTEGER CHECK (s3_force_path_style IS NULL OR s3_force_path_style IN (0, 1));

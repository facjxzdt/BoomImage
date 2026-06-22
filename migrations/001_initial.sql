CREATE TABLE images (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  original_mime TEXT NOT NULL,
  original_ext TEXT NOT NULL,
  original_path TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  has_alpha INTEGER NOT NULL DEFAULT 0 CHECK (has_alpha IN (0, 1)),
  is_animated INTEGER NOT NULL DEFAULT 0 CHECK (is_animated IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'partial', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX images_created_at_idx ON images (created_at DESC);
CREATE INDEX images_status_idx ON images (status) WHERE deleted_at IS NULL;

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  profile TEXT NOT NULL CHECK (profile IN ('display', 'thumb')),
  format TEXT NOT NULL CHECK (format IN ('avif', 'webp')),
  path TEXT NOT NULL UNIQUE,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (image_id, profile, format)
);

CREATE INDEX variants_image_id_idx ON variants (image_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('generate_variants', 'delete_files')),
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_until TEXT,
  worker_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX jobs_claim_idx ON jobs (state, available_at, lease_until);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


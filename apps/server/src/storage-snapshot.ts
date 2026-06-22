import type { AppConfig } from "./config.js";
import { s3LocationFromConfig, type StoredS3Location } from "./storage.js";

export interface StoredS3LocationColumns {
  s3_bucket: string | null;
  s3_object_key: string | null;
  s3_endpoint: string | null;
  s3_region: string | null;
  s3_public_base_url: string | null;
  s3_force_path_style: number | null;
}

export function s3LocationFromColumns(row: StoredS3LocationColumns): StoredS3Location | undefined {
  if (!row.s3_bucket || !row.s3_object_key || !row.s3_region || row.s3_force_path_style === null) {
    return undefined;
  }
  return {
    bucket: row.s3_bucket,
    objectKey: row.s3_object_key,
    endpoint: row.s3_endpoint ?? undefined,
    region: row.s3_region,
    publicBaseUrl: row.s3_public_base_url ?? undefined,
    forcePathStyle: row.s3_force_path_style === 1,
  };
}

export function s3LocationForStoredPath(
  config: AppConfig,
  storageDriver: "local" | "s3",
  storedPath: string,
): StoredS3Location | undefined {
  return storageDriver === "s3" ? s3LocationFromConfig(config.s3, storedPath) : undefined;
}

export function s3LocationValues(location: StoredS3Location | undefined): [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number | null,
] {
  return location
    ? [
      location.bucket,
      location.objectKey,
      location.endpoint ?? null,
      location.region,
      location.publicBaseUrl ?? null,
      location.forcePathStyle ? 1 : 0,
    ]
    : [null, null, null, null, null, null];
}

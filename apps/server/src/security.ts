import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./database.js";

function urlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function s3ImageOrigins(config: AppConfig): string[] {
  const origins = new Set<string>();
  const addOrigin = (value: string | undefined) => {
    const origin = urlOrigin(value);
    if (origin) origins.add(origin);
  };

  addOrigin(config.s3.publicBaseUrl);
  addOrigin(config.s3.endpoint);
  if (config.s3.bucket) {
    addOrigin(`https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`);
  }

  return Array.from(origins);
}

interface S3OriginRow {
  s3_endpoint: string | null;
  s3_public_base_url: string | null;
  s3_bucket: string | null;
  s3_region: string | null;
}

function historicalS3ImageOrigins(database: AppDatabase | undefined): string[] {
  if (!database) return [];
  const origins = new Set<string>();
  const addOrigin = (value: string | undefined | null) => {
    const origin = urlOrigin(value ?? undefined);
    if (origin) origins.add(origin);
  };

  const rows = database
    .prepare(
      `SELECT s3_endpoint, s3_public_base_url, s3_bucket, s3_region
       FROM images
       WHERE storage_driver = 's3'
       UNION
       SELECT v.s3_endpoint, v.s3_public_base_url, v.s3_bucket, v.s3_region
       FROM variants v
       JOIN images i ON i.id = v.image_id
       WHERE i.storage_driver = 's3'`,
    )
    .all() as unknown as S3OriginRow[];

  for (const row of rows) {
    addOrigin(row.s3_public_base_url);
    addOrigin(row.s3_endpoint);
    if (row.s3_bucket && row.s3_region) {
      addOrigin(`https://${row.s3_bucket}.s3.${row.s3_region}.amazonaws.com`);
    }
  }

  return Array.from(origins);
}

function contentSecurityPolicy(config: AppConfig, database?: AppDatabase): string {
  const imageSources = [
    "'self'",
    "data:",
    "blob:",
    ...s3ImageOrigins(config),
    ...historicalS3ImageOrigins(database),
  ].join(" ");

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig, database?: AppDatabase): void {
  app.addHook("onRequest", async (request, reply) => {
    const isPublicMediaRequest = request.url.startsWith("/media/");

    reply.header("Content-Security-Policy", contentSecurityPolicy(config, database));
    reply.header("Cross-Origin-Resource-Policy", isPublicMediaRequest ? "cross-origin" : "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");

    if (config.baseUrl.startsWith("https://")) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}

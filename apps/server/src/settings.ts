import type { FastifyInstance } from "fastify";
import { requireAuthentication } from "./auth.js";
import type { AppConfig, StorageAccessMode, StorageDriver } from "./config.js";
import { immediateTransaction, type AppDatabase } from "./database.js";

const SETTING_KEYS = {
  baseUrl: "APP_BASE_URL",
  maxUploadBytes: "MAX_UPLOAD_BYTES",
  maxInputPixels: "MAX_INPUT_PIXELS",
  jobLeaseSeconds: "JOB_LEASE_SECONDS",
  jobMaxAttempts: "JOB_MAX_ATTEMPTS",
  avifQuality: "AVIF_QUALITY",
  avifEffort: "AVIF_EFFORT",
  webpQuality: "WEBP_QUALITY",
  storageDriver: "STORAGE_DRIVER",
  storageAccessMode: "S3_ACCESS_MODE",
  s3Endpoint: "S3_ENDPOINT",
  s3Region: "S3_REGION",
  s3Bucket: "S3_BUCKET",
  s3Prefix: "S3_PREFIX",
  s3PublicBaseUrl: "S3_PUBLIC_BASE_URL",
  s3ForcePathStyle: "S3_FORCE_PATH_STYLE",
  s3AccessKeyId: "S3_ACCESS_KEY_ID",
  s3SecretAccessKey: "S3_SECRET_ACCESS_KEY",
  s3SessionToken: "S3_SESSION_TOKEN",
} as const;

export const MAX_UPLOAD_BYTES_HARD_LIMIT = 1_073_741_824;

interface SettingsRow {
  key: string;
  value: string;
}

export interface PublicRuntimeSettings {
  baseUrl: string;
  maxUploadBytes: number;
  maxInputPixels: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  avifQuality: number;
  avifEffort: number;
  webpQuality: number;
  storageDriver: StorageDriver;
  storageAccessMode: StorageAccessMode;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKeyConfigured: boolean;
    sessionTokenConfigured: boolean;
  };
}

interface RuntimeSettingsBody {
  baseUrl?: string;
  maxUploadBytes?: number;
  maxInputPixels?: number;
  jobLeaseSeconds?: number;
  jobMaxAttempts?: number;
  avifQuality?: number;
  avifEffort?: number;
  webpQuality?: number;
  storageDriver?: StorageDriver;
  storageAccessMode?: StorageAccessMode;
  s3?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    prefix?: string;
    publicBaseUrl?: string;
    forcePathStyle?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    clearSecretAccessKey?: boolean;
    sessionToken?: string;
    clearSessionToken?: boolean;
  };
}

function cloneS3Config(config: AppConfig): AppConfig["s3"] {
  return { ...config.s3 };
}

export function cloneAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    s3: cloneS3Config(config),
  };
}

function loadSettingsMap(database: AppDatabase): Map<string, string> {
  const rows = database.prepare("SELECT key, value FROM app_settings").all() as unknown as SettingsRow[];
  return new Map(rows.map((row) => [row.key, row.value]));
}

function normalizeOptionalUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }
  return trimmed.replace(/\/$/, "");
}

function normalizeBaseUrl(value: string): string {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) throw new Error("APP_BASE_URL is required");
  return normalized;
}

function normalizeS3Prefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function integerSetting(
  settings: Map<string, string>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!settings.has(key)) return fallback;
  const value = Number(settings.get(key));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stringSetting(settings: Map<string, string>, key: string, fallback = ""): string {
  return settings.has(key) ? settings.get(key) ?? "" : fallback;
}

function booleanSetting(settings: Map<string, string>, key: string, fallback: boolean): boolean {
  if (!settings.has(key)) return fallback;
  return settings.get(key) === "true";
}

function storageDriverSetting(settings: Map<string, string>, fallback: StorageDriver): StorageDriver {
  const value = stringSetting(settings, SETTING_KEYS.storageDriver, fallback);
  if (value !== "local" && value !== "s3") throw new Error("STORAGE_DRIVER must be one of: local, s3");
  return value;
}

function storageAccessModeSetting(settings: Map<string, string>, fallback: StorageAccessMode): StorageAccessMode {
  const value = stringSetting(settings, SETTING_KEYS.storageAccessMode, fallback);
  if (value !== "direct" && value !== "proxy") throw new Error("S3_ACCESS_MODE must be one of: direct, proxy");
  return value;
}

function configuredSecret(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export function applyStoredRuntimeSettings(
  database: AppDatabase,
  runtimeConfig: AppConfig,
  baseConfig: AppConfig,
): void {
  const settings = loadSettingsMap(database);

  runtimeConfig.baseUrl = settings.has(SETTING_KEYS.baseUrl)
    ? normalizeBaseUrl(settings.get(SETTING_KEYS.baseUrl) ?? "")
    : baseConfig.baseUrl;
  runtimeConfig.maxUploadBytes = integerSetting(
    settings,
    SETTING_KEYS.maxUploadBytes,
    baseConfig.maxUploadBytes,
    1,
    MAX_UPLOAD_BYTES_HARD_LIMIT,
  );
  runtimeConfig.maxInputPixels = integerSetting(
    settings,
    SETTING_KEYS.maxInputPixels,
    baseConfig.maxInputPixels,
    1,
    1_000_000_000,
  );
  runtimeConfig.jobLeaseSeconds = integerSetting(
    settings,
    SETTING_KEYS.jobLeaseSeconds,
    baseConfig.jobLeaseSeconds,
    30,
    3_600,
  );
  runtimeConfig.jobMaxAttempts = integerSetting(
    settings,
    SETTING_KEYS.jobMaxAttempts,
    baseConfig.jobMaxAttempts,
    1,
    10,
  );
  runtimeConfig.avifQuality = integerSetting(settings, SETTING_KEYS.avifQuality, baseConfig.avifQuality, 1, 100);
  runtimeConfig.avifEffort = integerSetting(settings, SETTING_KEYS.avifEffort, baseConfig.avifEffort, 0, 9);
  runtimeConfig.webpQuality = integerSetting(settings, SETTING_KEYS.webpQuality, baseConfig.webpQuality, 1, 100);
  runtimeConfig.storageDriver = storageDriverSetting(settings, baseConfig.storageDriver);
  runtimeConfig.storageAccessMode = storageAccessModeSetting(settings, baseConfig.storageAccessMode);

  runtimeConfig.s3 = cloneS3Config(baseConfig);
  if (settings.has(SETTING_KEYS.s3Endpoint)) {
    const endpoint = normalizeOptionalUrl(settings.get(SETTING_KEYS.s3Endpoint) ?? "");
    if (endpoint) runtimeConfig.s3.endpoint = endpoint;
    else delete runtimeConfig.s3.endpoint;
  }
  runtimeConfig.s3.region = stringSetting(settings, SETTING_KEYS.s3Region, baseConfig.s3.region).trim() || "auto";
  runtimeConfig.s3.bucket = stringSetting(settings, SETTING_KEYS.s3Bucket, baseConfig.s3.bucket).trim();
  runtimeConfig.s3.prefix = normalizeS3Prefix(stringSetting(settings, SETTING_KEYS.s3Prefix, baseConfig.s3.prefix));
  if (settings.has(SETTING_KEYS.s3PublicBaseUrl)) {
    const publicBaseUrl = normalizeOptionalUrl(settings.get(SETTING_KEYS.s3PublicBaseUrl) ?? "");
    if (publicBaseUrl) runtimeConfig.s3.publicBaseUrl = publicBaseUrl;
    else delete runtimeConfig.s3.publicBaseUrl;
  }
  runtimeConfig.s3.forcePathStyle = booleanSetting(
    settings,
    SETTING_KEYS.s3ForcePathStyle,
    baseConfig.s3.forcePathStyle,
  );
  if (settings.has(SETTING_KEYS.s3AccessKeyId)) {
    const accessKeyId = configuredSecret(settings.get(SETTING_KEYS.s3AccessKeyId));
    if (accessKeyId) runtimeConfig.s3.accessKeyId = accessKeyId;
    else delete runtimeConfig.s3.accessKeyId;
  }
  if (settings.has(SETTING_KEYS.s3SecretAccessKey)) {
    const secretAccessKey = configuredSecret(settings.get(SETTING_KEYS.s3SecretAccessKey));
    if (secretAccessKey) runtimeConfig.s3.secretAccessKey = secretAccessKey;
    else delete runtimeConfig.s3.secretAccessKey;
  }
  if (settings.has(SETTING_KEYS.s3SessionToken)) {
    const sessionToken = configuredSecret(settings.get(SETTING_KEYS.s3SessionToken));
    if (sessionToken) runtimeConfig.s3.sessionToken = sessionToken;
    else delete runtimeConfig.s3.sessionToken;
  }

  validateRuntimeConfig(runtimeConfig);
}

function validateRuntimeConfig(config: AppConfig): void {
  if (config.storageDriver === "s3" && !config.s3.bucket) {
    throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  if ((config.s3.accessKeyId && !config.s3.secretAccessKey) || (!config.s3.accessKeyId && config.s3.secretAccessKey)) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be provided together");
  }
}

function saveSetting(database: AppDatabase, key: string, value: string | number | boolean): void {
  database
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, String(value), new Date().toISOString());
}

function saveUpdateBody(database: AppDatabase, body: RuntimeSettingsBody): void {
  if (body.baseUrl !== undefined) saveSetting(database, SETTING_KEYS.baseUrl, normalizeBaseUrl(body.baseUrl));
  if (body.maxUploadBytes !== undefined) saveSetting(database, SETTING_KEYS.maxUploadBytes, body.maxUploadBytes);
  if (body.maxInputPixels !== undefined) saveSetting(database, SETTING_KEYS.maxInputPixels, body.maxInputPixels);
  if (body.jobLeaseSeconds !== undefined) saveSetting(database, SETTING_KEYS.jobLeaseSeconds, body.jobLeaseSeconds);
  if (body.jobMaxAttempts !== undefined) saveSetting(database, SETTING_KEYS.jobMaxAttempts, body.jobMaxAttempts);
  if (body.avifQuality !== undefined) saveSetting(database, SETTING_KEYS.avifQuality, body.avifQuality);
  if (body.avifEffort !== undefined) saveSetting(database, SETTING_KEYS.avifEffort, body.avifEffort);
  if (body.webpQuality !== undefined) saveSetting(database, SETTING_KEYS.webpQuality, body.webpQuality);
  if (body.storageDriver !== undefined) saveSetting(database, SETTING_KEYS.storageDriver, body.storageDriver);
  if (body.storageAccessMode !== undefined) saveSetting(database, SETTING_KEYS.storageAccessMode, body.storageAccessMode);

  if (body.s3) {
    if (body.s3.endpoint !== undefined) {
      saveSetting(database, SETTING_KEYS.s3Endpoint, normalizeOptionalUrl(body.s3.endpoint) ?? "");
    }
    if (body.s3.region !== undefined) saveSetting(database, SETTING_KEYS.s3Region, body.s3.region.trim() || "auto");
    if (body.s3.bucket !== undefined) saveSetting(database, SETTING_KEYS.s3Bucket, body.s3.bucket.trim());
    if (body.s3.prefix !== undefined) saveSetting(database, SETTING_KEYS.s3Prefix, normalizeS3Prefix(body.s3.prefix));
    if (body.s3.publicBaseUrl !== undefined) {
      saveSetting(database, SETTING_KEYS.s3PublicBaseUrl, normalizeOptionalUrl(body.s3.publicBaseUrl) ?? "");
    }
    if (body.s3.forcePathStyle !== undefined) saveSetting(database, SETTING_KEYS.s3ForcePathStyle, body.s3.forcePathStyle);
    if (body.s3.accessKeyId !== undefined) saveSetting(database, SETTING_KEYS.s3AccessKeyId, body.s3.accessKeyId.trim());
    if (body.s3.secretAccessKey !== undefined) {
      saveSetting(database, SETTING_KEYS.s3SecretAccessKey, body.s3.secretAccessKey);
    } else if (body.s3.clearSecretAccessKey) {
      saveSetting(database, SETTING_KEYS.s3SecretAccessKey, "");
    }
    if (body.s3.sessionToken !== undefined) {
      saveSetting(database, SETTING_KEYS.s3SessionToken, body.s3.sessionToken);
    } else if (body.s3.clearSessionToken) {
      saveSetting(database, SETTING_KEYS.s3SessionToken, "");
    }
  }
}

export function publicRuntimeSettings(config: AppConfig): PublicRuntimeSettings {
  return {
    baseUrl: config.baseUrl,
    maxUploadBytes: config.maxUploadBytes,
    maxInputPixels: config.maxInputPixels,
    jobLeaseSeconds: config.jobLeaseSeconds,
    jobMaxAttempts: config.jobMaxAttempts,
    avifQuality: config.avifQuality,
    avifEffort: config.avifEffort,
    webpQuality: config.webpQuality,
    storageDriver: config.storageDriver,
    storageAccessMode: config.storageAccessMode,
    s3: {
      endpoint: config.s3.endpoint ?? "",
      region: config.s3.region,
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
      publicBaseUrl: config.s3.publicBaseUrl ?? "",
      forcePathStyle: config.s3.forcePathStyle,
      accessKeyId: config.s3.accessKeyId ?? "",
      secretAccessKeyConfigured: Boolean(config.s3.secretAccessKey),
      sessionTokenConfigured: Boolean(config.s3.sessionToken),
    },
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  runtimeConfig: AppConfig,
  baseConfig: AppConfig,
): void {
  const updateSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string", minLength: 1, maxLength: 512 },
      maxUploadBytes: { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES_HARD_LIMIT },
      maxInputPixels: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
      jobLeaseSeconds: { type: "integer", minimum: 30, maximum: 3_600 },
      jobMaxAttempts: { type: "integer", minimum: 1, maximum: 10 },
      avifQuality: { type: "integer", minimum: 1, maximum: 100 },
      avifEffort: { type: "integer", minimum: 0, maximum: 9 },
      webpQuality: { type: "integer", minimum: 1, maximum: 100 },
      storageDriver: { type: "string", enum: ["local", "s3"] },
      storageAccessMode: { type: "string", enum: ["direct", "proxy"] },
      s3: {
        type: "object",
        additionalProperties: false,
        properties: {
          endpoint: { type: "string", maxLength: 512 },
          region: { type: "string", minLength: 0, maxLength: 128 },
          bucket: { type: "string", maxLength: 255 },
          prefix: { type: "string", maxLength: 255 },
          publicBaseUrl: { type: "string", maxLength: 512 },
          forcePathStyle: { type: "boolean" },
          accessKeyId: { type: "string", maxLength: 512 },
          secretAccessKey: { type: "string", maxLength: 2_048 },
          clearSecretAccessKey: { type: "boolean" },
          sessionToken: { type: "string", maxLength: 4_096 },
          clearSessionToken: { type: "boolean" },
        },
      },
    },
  } as const;

  app.get(
    "/api/v1/settings",
    { preHandler: requireAuthentication(database, { csrf: false, allowApiToken: false }) },
    async () => ({ settings: publicRuntimeSettings(runtimeConfig) }),
  );

  app.put<{ Body: RuntimeSettingsBody }>(
    "/api/v1/settings",
    {
      preHandler: requireAuthentication(database, { csrf: true, allowApiToken: false }),
      schema: { body: updateSchema },
    },
    async (request, reply) => {
      const previousSettings = loadSettingsMap(database);
      try {
        immediateTransaction(database, () => saveUpdateBody(database, request.body));
        applyStoredRuntimeSettings(database, runtimeConfig, baseConfig);
      } catch (error) {
        immediateTransaction(database, () => {
          database.prepare("DELETE FROM app_settings").run();
          for (const [key, value] of previousSettings) saveSetting(database, key, value);
        });
        applyStoredRuntimeSettings(database, runtimeConfig, baseConfig);
        app.log.warn({ err: error }, "Rejected invalid runtime settings update");
        return reply.code(400).send({ status: "error", code: "INVALID_SETTINGS" });
      }
      return { settings: publicRuntimeSettings(runtimeConfig) };
    },
  );
}

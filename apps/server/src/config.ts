import { existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  migrationsDir: string;
  webDistDir: string;
  baseUrl: string;
  sessionTtlSeconds: number;
  authRateLimitWindowMs: number;
  authRateLimitMaxAttempts: number;
  logLevel: LogLevel;
  maxUploadBytes: number;
  maxInputPixels: number;
  tmpFileTtlSeconds: number;
  tmpCleanupIntervalSeconds: number;
  imageWorkers: number;
  jobPollIntervalMs: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  avifQuality: number;
  avifEffort: number;
  webpQuality: number;
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function logLevelFromEnv(value: string | undefined): LogLevel {
  const level = value ?? "info";
  const levels: readonly LogLevel[] = [
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ];

  if (!levels.includes(level as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${levels.join(", ")}`);
  }

  return level as LogLevel;
}

function findProjectRoot(start = process.cwd()): string {
  let current = resolve(start);
  const root = parse(current).root;

  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    if (current === root) return resolve(start);
    current = dirname(current);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const projectRoot = findProjectRoot();
  const dataDir = resolve(env.APP_DATA_DIR ?? resolve(projectRoot, "data"));

  return {
    host: env.APP_HOST ?? "0.0.0.0",
    port: integerFromEnv(env, "APP_PORT", 3000, 1, 65_535),
    dataDir,
    databasePath: resolve(env.DATABASE_PATH ?? `${dataDir}/boomimage.db`),
    migrationsDir: resolve(env.MIGRATIONS_DIR ?? resolve(projectRoot, "migrations")),
    webDistDir: resolve(env.WEB_DIST_DIR ?? resolve(projectRoot, "apps/web/dist")),
    baseUrl: (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    sessionTtlSeconds: integerFromEnv(env, "SESSION_TTL_SECONDS", 2_592_000, 300, 31_536_000),
    authRateLimitWindowMs: integerFromEnv(
      env,
      "AUTH_RATE_LIMIT_WINDOW_MS",
      900_000,
      1_000,
      86_400_000,
    ),
    authRateLimitMaxAttempts: integerFromEnv(env, "AUTH_RATE_LIMIT_MAX_ATTEMPTS", 10, 1, 1_000),
    logLevel: logLevelFromEnv(env.LOG_LEVEL),
    maxUploadBytes: integerFromEnv(env, "MAX_UPLOAD_BYTES", 52_428_800, 1, 1_073_741_824),
    maxInputPixels: integerFromEnv(env, "MAX_INPUT_PIXELS", 50_000_000, 1, 1_000_000_000),
    tmpFileTtlSeconds: integerFromEnv(env, "TMP_FILE_TTL_SECONDS", 86_400, 3_600, 31_536_000),
    tmpCleanupIntervalSeconds: integerFromEnv(
      env,
      "TMP_CLEANUP_INTERVAL_SECONDS",
      3_600,
      0,
      86_400,
    ),
    imageWorkers: integerFromEnv(env, "IMAGE_WORKERS", 2, 1, 64),
    jobPollIntervalMs: integerFromEnv(env, "JOB_POLL_INTERVAL_MS", 1_000, 100, 60_000),
    jobLeaseSeconds: integerFromEnv(env, "JOB_LEASE_SECONDS", 300, 30, 3_600),
    jobMaxAttempts: integerFromEnv(env, "JOB_MAX_ATTEMPTS", 3, 1, 10),
    avifQuality: integerFromEnv(env, "AVIF_QUALITY", 50, 1, 100),
    avifEffort: integerFromEnv(env, "AVIF_EFFORT", 4, 0, 9),
    webpQuality: integerFromEnv(env, "WEBP_QUALITY", 82, 1, 100),
  };
}

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { assertDatabaseReady, openDatabase } from "./database.js";
import {
  assertDirectoryWritable,
  cleanupTemporaryFiles,
  prepareDataDirectories,
} from "./filesystem.js";
import { registerImageRoutes } from "./images.js";
import { registerSecurityHeaders } from "./security.js";
import {
  applyStoredRuntimeSettings,
  cloneAppConfig,
  MAX_UPLOAD_BYTES_HARD_LIMIT,
  registerSettingsRoutes,
} from "./settings.js";
import { createMediaStorage, type MediaStorage } from "./storage.js";
import { ImageWorker } from "./worker.js";

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  startMaintenance?: boolean;
  startWorkers?: boolean;
  storage?: MediaStorage;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const baseConfig = cloneAppConfig(options.config ?? loadConfig());
  const config = cloneAppConfig(baseConfig);
  const directories = await prepareDataDirectories(config.dataDir);
  const database = await openDatabase(config.databasePath, config.migrationsDir);
  applyStoredRuntimeSettings(database, config, baseConfig);
  const storage = options.storage ?? createMediaStorage(config, directories);

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
  });

  registerSecurityHeaders(app, config);

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 5,
      parts: 6,
      fileSize: MAX_UPLOAD_BYTES_HARD_LIMIT,
    },
  });

  await app.register(fastifyStatic, {
    root: directories.originals,
    prefix: "/media/originals/",
    decorateReply: false,
    immutable: true,
    maxAge: "1y",
  });
  await app.register(fastifyStatic, {
    root: directories.variants,
    prefix: "/media/variants/",
    decorateReply: false,
    immutable: true,
    maxAge: "1y",
  });

  const hasWebApp = existsSync(config.webDistDir);
  if (hasWebApp) {
    await app.register(fastifyStatic, {
      root: join(config.webDistDir, "assets"),
      prefix: "/assets/",
      decorateReply: false,
      immutable: true,
      maxAge: "1y",
    });
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/",
      decorateReply: false,
      wildcard: false,
    });
  }

  if (!hasWebApp) {
    app.get("/", async () => ({
      name: "BoomImage",
      version: "0.1.0",
      status: "running",
    }));
  }

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      assertDatabaseReady(database);
      await assertDirectoryWritable(directories.temporary);
      return { status: "ready" };
    } catch (error) {
      app.log.error({ err: error }, "Readiness check failed");
      return reply.code(503).send({
        status: "unavailable",
        code: "SERVICE_NOT_READY",
      });
    }
  });

  registerAuthRoutes(app, database, config);
  registerSettingsRoutes(app, database, config, baseConfig);
  registerImageRoutes(app, database, config, directories, storage);

  let temporaryCleanupTimer: NodeJS.Timeout | undefined;
  const shouldStartMaintenance = options.startMaintenance ?? process.env.NODE_ENV !== "test";
  const runTemporaryCleanup = async () => {
    try {
      const result = await cleanupTemporaryFiles(directories.temporary, {
        olderThanMs: config.tmpFileTtlSeconds * 1_000,
      });
      if (result.deleted > 0 || result.errors > 0) {
        app.log.info(
          {
            scanned: result.scanned,
            deleted: result.deleted,
            skipped: result.skipped,
            errors: result.errors,
          },
          "Temporary file cleanup completed",
        );
      }
    } catch (error) {
      app.log.warn({ err: error }, "Temporary file cleanup failed");
    }
  };
  if (shouldStartMaintenance && config.tmpCleanupIntervalSeconds > 0) {
    void runTemporaryCleanup();
    temporaryCleanupTimer = setInterval(
      () => void runTemporaryCleanup(),
      config.tmpCleanupIntervalSeconds * 1_000,
    );
    temporaryCleanupTimer.unref();
  }

  const shouldStartWorkers = options.startWorkers ?? process.env.NODE_ENV !== "test";
  const worker = shouldStartWorkers
    ? new ImageWorker({ database, config, directories, storage, logger: app.log })
    : undefined;
  worker?.start();

  app.addHook("onClose", async () => {
    if (temporaryCleanupTimer) clearInterval(temporaryCleanupTimer);
    await worker?.stop();
    database.close();
  });

  return app;
}

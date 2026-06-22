import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase, type AppDatabase } from "../src/database.js";
import { prepareDataDirectories, type DataDirectories } from "../src/filesystem.js";
import { ImageWorker } from "../src/worker.js";

const cleanupDirectories: string[] = [];
const password = "correct horse battery staple";
const logger = {
  info: () => undefined,
  error: () => undefined,
};

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function multipartImage(image: Buffer) {
  const boundary = `boomimage-worker-${Date.now()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function uploadedImageFixture(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  config: AppConfig;
  database: AppDatabase;
  directories: DataDirectories;
  imageId: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-worker-test-"));
  cleanupDirectories.push(dataDir);
  const config = loadConfig({
    APP_DATA_DIR: dataDir,
    MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
    APP_BASE_URL: "https://img.example.test",
    JOB_POLL_INTERVAL_MS: "100",
    JOB_MAX_ATTEMPTS: "3",
    IMAGE_WORKERS: "1",
    LOG_LEVEL: "silent",
  });
  const app = await buildApp({ config, logger: false, startWorkers: false });
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password },
  });
  const setCookie = setup.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof cookieValue !== "string") throw new Error("Expected a session cookie");

  const sourcePng = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 30, g: 120, b: 220, alpha: 0.75 },
    },
  })
    .png()
    .toBuffer();
  const multipart = multipartImage(sourcePng);
  const upload = await app.inject({
    method: "POST",
    url: "/api/v1/images",
    headers: {
      cookie: cookieValue.split(";", 1)[0] ?? "",
      "x-csrf-token": setup.json().csrfToken as string,
      "content-type": multipart.contentType,
    },
    payload: multipart.payload,
  });
  expect(upload.statusCode).toBe(201);

  return {
    app,
    config,
    database: await openDatabase(config.databasePath, config.migrationsDir),
    directories: await prepareDataDirectories(config.dataDir),
    imageId: upload.json().image.id as string,
  };
}

describe("image conversion worker", () => {
  it("generates all AVIF and WebP variants and completes the job", async () => {
    const fixture = await uploadedImageFixture();
    const worker = new ImageWorker({
      database: fixture.database,
      config: fixture.config,
      directories: fixture.directories,
      logger,
    });

    try {
      expect(await worker.processNextJob("test-worker")).toBe(true);

      const image = fixture.database
        .prepare("SELECT status FROM images WHERE id = ?")
        .get(fixture.imageId) as unknown as { status: string };
      const variants = fixture.database
        .prepare("SELECT path, status, width, height, size_bytes FROM variants WHERE image_id = ?")
        .all(fixture.imageId) as unknown as Array<{
        path: string;
        status: string;
        width: number;
        height: number;
        size_bytes: number;
      }>;
      const job = fixture.database
        .prepare("SELECT state FROM jobs WHERE image_id = ?")
        .get(fixture.imageId) as unknown as { state: string };

      expect(image.status).toBe("ready");
      expect(job.state).toBe("succeeded");
      expect(variants).toHaveLength(4);
      expect(variants.every((variant) => variant.status === "ready")).toBe(true);
      for (const variant of variants) {
        expect(variant.width).toBe(2);
        expect(variant.height).toBe(2);
        expect(variant.size_bytes).toBeGreaterThan(0);
        expect((await stat(join(fixture.config.dataDir, ...variant.path.split("/")))).size).toBeGreaterThan(0);
      }
    } finally {
      fixture.database.close();
      await fixture.app.close();
    }
  });

  it("reclaims an expired lease and eventually fails a missing source", async () => {
    const fixture = await uploadedImageFixture();
    const original = fixture.database
      .prepare("SELECT original_path FROM images WHERE id = ?")
      .get(fixture.imageId) as unknown as { original_path: string };
    await unlink(join(fixture.config.dataDir, ...original.original_path.split("/")));
    fixture.database
      .prepare(
        `UPDATE jobs SET state = 'running', attempts = 0, lease_until = ?, worker_id = 'dead-worker'
         WHERE image_id = ?`,
      )
      .run(new Date(Date.now() - 60_000).toISOString(), fixture.imageId);

    const worker = new ImageWorker({
      database: fixture.database,
      config: fixture.config,
      directories: fixture.directories,
      logger,
    });

    try {
      for (let attempt = 1; attempt <= fixture.config.jobMaxAttempts; attempt += 1) {
        expect(await worker.processNextJob("recovery-worker")).toBe(true);
        if (attempt < fixture.config.jobMaxAttempts) {
          fixture.database
            .prepare("UPDATE jobs SET available_at = ? WHERE image_id = ?")
            .run(new Date(Date.now() - 1_000).toISOString(), fixture.imageId);
        }
      }

      const job = fixture.database
        .prepare("SELECT state, attempts, last_error FROM jobs WHERE image_id = ?")
        .get(fixture.imageId) as unknown as { state: string; attempts: number; last_error: string };
      const image = fixture.database
        .prepare("SELECT status FROM images WHERE id = ?")
        .get(fixture.imageId) as unknown as { status: string };
      expect(job.state).toBe("failed");
      expect(job.attempts).toBe(3);
      expect(job.last_error).not.toContain(fixture.config.dataDir);
      expect(image.status).toBe("failed");
    } finally {
      fixture.database.close();
      await fixture.app.close();
    }
  });
});

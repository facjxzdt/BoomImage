import { mkdir, rename, unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import sharp, { type OutputInfo } from "sharp";
import type { AppConfig } from "./config.js";
import { immediateTransaction, type AppDatabase } from "./database.js";
import type { DataDirectories } from "./filesystem.js";
import { s3LocationFromColumns, type StoredS3LocationColumns } from "./storage-snapshot.js";
import type { MediaAccessMode, MediaStorage } from "./storage.js";

interface ClaimedJob {
  id: string;
  type: "generate_variants" | "delete_files";
  imageId: string;
  attempts: number;
}

interface ImageSourceRow extends StoredS3LocationColumns {
  original_path: string;
  storage_driver: "local" | "s3";
  access_mode: MediaAccessMode;
  original_mime: string;
}

interface DeletedImageRow extends ImageSourceRow {
  deleted_at: string | null;
}

interface VariantJobRow extends StoredS3LocationColumns {
  id: string;
  profile: "display" | "thumb";
  format: "avif" | "webp";
  path: string;
  status: "pending" | "ready" | "failed";
}

interface WorkerLogger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export interface ImageWorkerOptions {
  database: AppDatabase;
  config: AppConfig;
  directories: DataDirectories;
  storage: MediaStorage;
  logger: WorkerLogger;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function pathWithin(root: string, storedPath: string): string {
  if (isAbsolute(storedPath)) throw new Error("Stored media path must be relative");
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, storedPath);
  const difference = relative(resolvedRoot, resolvedPath);
  if (difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Stored media path escapes the data directory");
  }
  return resolvedPath;
}

function errorMessage(error: unknown, dataDirectory: string): string {
  const message = error instanceof Error ? error.message : "Unknown image conversion error";
  return message.split(resolve(dataDirectory)).join("<data>").slice(0, 2_000);
}

export class ImageWorker {
  readonly #database: AppDatabase;
  readonly #config: AppConfig;
  readonly #directories: DataDirectories;
  readonly #storage: MediaStorage;
  readonly #logger: WorkerLogger;
  readonly #workerPrefix = `worker-${process.pid}`;
  #stopping = false;
  #loops: Promise<void>[] = [];

  constructor(options: ImageWorkerOptions) {
    this.#database = options.database;
    this.#config = options.config;
    this.#directories = options.directories;
    this.#storage = options.storage;
    this.#logger = options.logger;
    sharp.concurrency(Math.max(1, Math.floor(availableParallelism() / this.#config.imageWorkers)));
  }

  start(): void {
    if (this.#loops.length > 0) return;
    this.#stopping = false;
    this.#loops = Array.from({ length: this.#config.imageWorkers }, (_, index) =>
      this.#runLoop(`${this.#workerPrefix}-${index + 1}`),
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.all(this.#loops);
    this.#loops = [];
  }

  async #runLoop(workerId: string): Promise<void> {
    while (!this.#stopping) {
      try {
        const processed = await this.processNextJob(workerId);
        if (!processed) await sleep(this.#config.jobPollIntervalMs);
      } catch (error) {
        this.#logger.error({ err: error, workerId }, "Image worker iteration failed");
        await sleep(this.#config.jobPollIntervalMs);
      }
    }
  }

  async processNextJob(workerId = `${this.#workerPrefix}-manual`): Promise<boolean> {
    const job = this.#claimJob(workerId);
    if (!job) return false;

    this.#logger.info({ jobId: job.id, jobType: job.type, imageId: job.imageId, attempts: job.attempts }, "Processing image job");
    await this.#processClaimedJob(job);
    return true;
  }

  #claimJob(workerId: string): ClaimedJob | undefined {
    return immediateTransaction(this.#database, () => {
      const now = new Date();
      const row = this.#database
        .prepare(
          `SELECT id, type, image_id, attempts
           FROM jobs
           WHERE attempts < ?
             AND (
               (state = 'pending' AND available_at <= ?)
               OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
             )
           ORDER BY CASE type WHEN 'delete_files' THEN 0 ELSE 1 END, available_at, created_at
           LIMIT 1`,
        )
        .get(this.#config.jobMaxAttempts, now.toISOString(), now.toISOString()) as unknown as
        | { id: string; type: "generate_variants" | "delete_files"; image_id: string; attempts: number }
        | undefined;
      if (!row) return undefined;

      const leaseUntil = new Date(now.getTime() + this.#config.jobLeaseSeconds * 1_000).toISOString();
      const attempts = row.attempts + 1;
      this.#database
        .prepare(
          `UPDATE jobs
           SET state = 'running', attempts = ?, lease_until = ?, worker_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(attempts, leaseUntil, workerId, now.toISOString(), row.id);
      this.#database
        .prepare("UPDATE images SET status = 'processing', updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(now.toISOString(), row.image_id);
      return { id: row.id, type: row.type, imageId: row.image_id, attempts };
    });
  }

  async #processClaimedJob(job: ClaimedJob): Promise<void> {
    if (job.type === "delete_files") {
      await this.#processDeleteFilesJob(job);
      return;
    }

    const image = this.#database
      .prepare(
        `SELECT original_path, original_mime, storage_driver, access_mode,
                s3_bucket, s3_object_key, s3_endpoint, s3_region, s3_public_base_url, s3_force_path_style
         FROM images WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(job.imageId) as unknown as ImageSourceRow | undefined;
    if (!image) {
      this.#finishMissingImage(job);
      return;
    }

    const variants = this.#database
      .prepare(
        `SELECT id, profile, format, path, status,
                s3_bucket, s3_object_key, s3_endpoint, s3_region, s3_public_base_url, s3_force_path_style
         FROM variants WHERE image_id = ? AND status != 'ready'
         ORDER BY profile, format`,
      )
      .all(job.imageId) as unknown as VariantJobRow[];
    const sourcePath = join(this.#directories.temporary, `${job.imageId}-${job.id}-source`);
    const failures: Array<{ variant: VariantJobRow; error: string }> = [];

    try {
      await unlink(sourcePath).catch(() => undefined);
      await this.#storage.materializeToLocal({
        storageDriver: image.storage_driver,
        accessMode: image.access_mode,
        path: image.original_path,
        contentType: image.original_mime,
        s3: s3LocationFromColumns(image),
      }, sourcePath);
      for (const variant of variants) {
        try {
          const info = await this.#renderVariant(sourcePath, variant, image, job.id);
          this.#markVariantReady(variant.id, info);
        } catch (error) {
          failures.push({ variant, error: errorMessage(error, this.#directories.root) });
        }
      }
    } catch (error) {
      const message = errorMessage(error, this.#directories.root);
      failures.push(...variants.map((variant) => ({ variant, error: message })));
    } finally {
      await unlink(sourcePath).catch(() => undefined);
    }

    if (failures.length === 0) {
      this.#finishSuccessfulJob(job);
    } else if (job.attempts < this.#config.jobMaxAttempts) {
      this.#scheduleRetry(job, failures);
    } else {
      this.#finishFailedJob(job, failures);
    }
  }

  async #processDeleteFilesJob(job: ClaimedJob): Promise<void> {
    const image = this.#database
      .prepare(
        `SELECT original_path, original_mime, storage_driver, access_mode, deleted_at,
                s3_bucket, s3_object_key, s3_endpoint, s3_region, s3_public_base_url, s3_force_path_style
         FROM images WHERE id = ?`,
      )
      .get(job.imageId) as unknown as DeletedImageRow | undefined;
    if (!image) {
      this.#finishSuccessfulDeleteJob(job);
      return;
    }
    if (image.deleted_at === null) {
      this.#finishFailedDeleteJob(job, ["Image is not soft-deleted"]);
      return;
    }

    const variants = this.#database
      .prepare(
        `SELECT path, s3_bucket, s3_object_key, s3_endpoint, s3_region,
                s3_public_base_url, s3_force_path_style
         FROM variants WHERE image_id = ?`,
      )
      .all(job.imageId) as unknown as Array<{ path: string } & StoredS3LocationColumns>;
    const medias = [
      {
        storageDriver: image.storage_driver,
        accessMode: image.access_mode,
        path: image.original_path,
        contentType: image.original_mime,
        s3: s3LocationFromColumns(image),
      },
      ...variants.map((variant) => ({
        storageDriver: image.storage_driver,
        accessMode: image.access_mode,
        path: variant.path,
        s3: s3LocationFromColumns(variant),
      })),
    ];
    const failures: string[] = [];

    for (const media of medias) {
      try {
        await this.#storage.delete(media);
      } catch (error) {
        failures.push(`${media.path}: ${errorMessage(error, this.#directories.root)}`);
      }
    }

    if (failures.length === 0) {
      this.#finishSuccessfulDeleteJob(job);
    } else if (job.attempts < this.#config.jobMaxAttempts) {
      this.#scheduleDeleteRetry(job, failures);
    } else {
      this.#finishFailedDeleteJob(job, failures);
    }
  }

  async #renderVariant(
    sourcePath: string,
    variant: VariantJobRow,
    image: ImageSourceRow,
    jobId: string,
  ): Promise<OutputInfo> {
    const targetPath = pathWithin(this.#directories.root, variant.path);
    const temporaryPath = join(
      this.#directories.temporary,
      `${variant.id}-${jobId}.${variant.format}.tmp`,
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await unlink(temporaryPath).catch(() => undefined);

    const width = variant.profile === "display" ? 2_560 : 480;
    let conversion = sharp(sourcePath, { limitInputPixels: this.#config.maxInputPixels })
      .rotate()
      .resize({ width, withoutEnlargement: true });
    conversion =
      variant.format === "avif"
        ? conversion.avif({ quality: this.#config.avifQuality, effort: this.#config.avifEffort })
        : conversion.webp({ quality: this.#config.webpQuality });

    try {
      const info = await conversion.toFile(temporaryPath);
      if (image.storage_driver === "local") {
        await unlink(targetPath).catch(() => undefined);
        await mkdir(dirname(targetPath), { recursive: true });
        await rename(temporaryPath, targetPath);
      } else {
        await this.#storage.storeFile({
          storageDriver: image.storage_driver,
          accessMode: image.access_mode,
          path: variant.path,
          sourcePath: temporaryPath,
          contentType: `image/${variant.format}`,
          s3: s3LocationFromColumns(variant),
          move: true,
        });
      }
      return info;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #markVariantReady(variantId: string, info: OutputInfo): void {
    this.#database
      .prepare(
        `UPDATE variants
         SET width = ?, height = ?, size_bytes = ?, status = 'ready', error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(info.width, info.height, info.size, new Date().toISOString(), variantId);
  }

  #finishSuccessfulJob(job: ClaimedJob): void {
    const now = new Date().toISOString();
    immediateTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE jobs SET state = 'succeeded', lease_until = NULL, worker_id = NULL,
             last_error = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, job.id);
      this.#database
        .prepare("UPDATE images SET status = 'ready', updated_at = ? WHERE id = ?")
        .run(now, job.imageId);
    });
  }

  #finishSuccessfulDeleteJob(job: ClaimedJob): void {
    immediateTransaction(this.#database, () => {
      this.#database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
      this.#database.prepare("DELETE FROM images WHERE id = ?").run(job.imageId);
    });
  }

  #scheduleRetry(
    job: ClaimedJob,
    failures: Array<{ variant: VariantJobRow; error: string }>,
  ): void {
    const now = new Date();
    const retryAt = new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 1_000).toISOString();
    const combinedError = failures.map(({ variant, error }) => `${variant.profile}.${variant.format}: ${error}`).join("; ");
    immediateTransaction(this.#database, () => {
      for (const failure of failures) {
        this.#database
          .prepare("UPDATE variants SET status = 'pending', error = ?, updated_at = ? WHERE id = ?")
          .run(failure.error, now.toISOString(), failure.variant.id);
      }
      this.#database
        .prepare(
          `UPDATE jobs SET state = 'pending', available_at = ?, lease_until = NULL,
             worker_id = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(retryAt, combinedError.slice(0, 2_000), now.toISOString(), job.id);
      this.#database
        .prepare("UPDATE images SET status = 'processing', updated_at = ? WHERE id = ?")
        .run(now.toISOString(), job.imageId);
    });
  }

  #finishFailedJob(
    job: ClaimedJob,
    failures: Array<{ variant: VariantJobRow; error: string }>,
  ): void {
    const now = new Date().toISOString();
    const combinedError = failures.map(({ variant, error }) => `${variant.profile}.${variant.format}: ${error}`).join("; ");
    immediateTransaction(this.#database, () => {
      for (const failure of failures) {
        this.#database
          .prepare("UPDATE variants SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
          .run(failure.error, now, failure.variant.id);
      }
      const readyCount = this.#database
        .prepare("SELECT COUNT(*) AS count FROM variants WHERE image_id = ? AND status = 'ready'")
        .get(job.imageId) as unknown as { count: number };
      this.#database
        .prepare(
          `UPDATE jobs SET state = 'failed', lease_until = NULL, worker_id = NULL,
             last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(combinedError.slice(0, 2_000), now, job.id);
      this.#database
        .prepare("UPDATE images SET status = ?, updated_at = ? WHERE id = ?")
        .run(Number(readyCount.count) > 0 ? "partial" : "failed", now, job.imageId);
    });
  }

  #scheduleDeleteRetry(job: ClaimedJob, failures: string[]): void {
    const now = new Date();
    const retryAt = new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 1_000).toISOString();
    const combinedError = failures.join("; ").slice(0, 2_000);
    immediateTransaction(this.#database, () => {
      this.#database
        .prepare(
          `UPDATE jobs SET state = 'pending', available_at = ?, lease_until = NULL,
             worker_id = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(retryAt, combinedError, now.toISOString(), job.id);
    });
  }

  #finishFailedDeleteJob(job: ClaimedJob, failures: string[]): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE jobs SET state = 'failed', lease_until = NULL, worker_id = NULL,
           last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(failures.join("; ").slice(0, 2_000), now, job.id);
  }

  #finishMissingImage(job: ClaimedJob): void {
    this.#database
      .prepare(
        `UPDATE jobs SET state = 'failed', lease_until = NULL, worker_id = NULL,
           last_error = 'Image record is missing', updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), job.id);
  }
}

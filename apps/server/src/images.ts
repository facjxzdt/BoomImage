import { createHash, randomUUID, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { ulid } from "ulid";
import { requireAuthentication } from "./auth.js";
import type { AppConfig } from "./config.js";
import { immediateTransaction, type AppDatabase } from "./database.js";
import type { DataDirectories } from "./filesystem.js";
import type { MediaAccessMode, MediaStorage, StoredMedia } from "./storage.js";

interface DetectedImageType {
  extension: "jpg" | "png" | "webp" | "gif" | "avif";
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";
}

interface ImageRow {
  id: string;
  sha256: string;
  original_name: string;
  original_mime: string;
  original_path: string;
  width: number;
  height: number;
  size_bytes: number;
  has_alpha: number;
  is_animated: number;
  status: string;
  storage_driver: "local" | "s3";
  access_mode: MediaAccessMode;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  profile: string;
  format: string;
  path: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  status: string;
  error: string | null;
}

function hashingTransform(hash: Hash, countBytes: (size: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      countBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

function detectImageType(header: Buffer): DetectedImageType | undefined {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mime: "image/png" };
  }
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mime: "image/webp" };
  }
  const gifHeader = header.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { extension: "gif", mime: "image/gif" };
  }
  if (header.length >= 16 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = header.subarray(8, 32).toString("ascii");
    if (brands.includes("avif") || brands.includes("avis")) {
      return { extension: "avif", mime: "image/avif" };
    }
  }
  return undefined;
}

function cleanOriginalName(filename: string): string {
  const cleaned = basename(filename).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "image").slice(0, 255);
}

function storedFilePath(root: string, storedPath: string): string {
  if (isAbsolute(storedPath)) throw new Error("Stored media path must be relative");
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, storedPath);
  const difference = relative(resolvedRoot, resolvedPath);
  if (difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Stored media path escapes the data directory");
  }
  return resolvedPath;
}

function getImage(database: AppDatabase, id: string): ImageRow | undefined {
  return database
    .prepare(
      `SELECT id, sha256, original_name, original_mime, original_path, width, height,
              size_bytes, has_alpha, is_animated, status, storage_driver, access_mode,
              created_at, updated_at
       FROM images WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as unknown as ImageRow | undefined;
}

function serializeImage(database: AppDatabase, storage: MediaStorage, image: ImageRow) {
  const variants = database
    .prepare(
      `SELECT profile, format, path, width, height, size_bytes, status, error
       FROM variants WHERE image_id = ? ORDER BY profile, format`,
    )
    .all(image.id) as unknown as VariantRow[];

  return {
    id: image.id,
    sha256: image.sha256,
    originalName: image.original_name,
    mime: image.original_mime,
    width: image.width,
    height: image.height,
    sizeBytes: image.size_bytes,
    hasAlpha: image.has_alpha === 1,
    isAnimated: image.is_animated === 1,
    status: image.status,
    storageDriver: image.storage_driver,
    accessMode: image.access_mode,
    createdAt: image.created_at,
    updatedAt: image.updated_at,
    originalUrl: storage.publicUrl({
      storageDriver: image.storage_driver,
      accessMode: image.access_mode,
      path: image.original_path,
      contentType: image.original_mime,
    }),
    variants: variants.map((variant) => ({
      profile: variant.profile,
      format: variant.format,
      width: variant.width,
      height: variant.height,
      sizeBytes: variant.size_bytes,
      status: variant.status,
      error: variant.error,
      url: variant.status === "ready"
        ? storage.publicUrl({
          storageDriver: image.storage_driver,
          accessMode: image.access_mode,
          path: variant.path,
        })
        : null,
    })),
  };
}

function parseStorageField(value: unknown, fallback: "local" | "s3"): "local" | "s3" {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "local" || value === "s3") return value;
  throw new Error("INVALID_STORAGE_DRIVER");
}

function parseAccessField(value: unknown, fallback: MediaAccessMode): MediaAccessMode {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "direct" || value === "proxy") return value;
  throw new Error("INVALID_ACCESS_MODE");
}

function isUniqueConstraintError(error: unknown): boolean {
  const sqliteError = error as { code?: unknown; message?: unknown };
  return sqliteError.code === "ERR_SQLITE_ERROR"
    && typeof sqliteError.message === "string"
    && sqliteError.message.includes("UNIQUE constraint failed");
}

function normalizeMediaPath(path: string): string {
  const normalized = path.split("\\").join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("/../") || normalized.startsWith("../")) {
    throw new Error("Invalid media path");
  }
  return normalized;
}

export function registerImageRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  config: AppConfig,
  directories: DataDirectories,
  storage: MediaStorage,
): void {
  app.get<{ Params: { "*": string } }>(
    "/media/proxy/*",
    async (request, reply) => {
      let mediaPath: string;
      try {
        mediaPath = normalizeMediaPath(request.params["*"]);
      } catch {
        return reply.code(404).send({ status: "error", code: "MEDIA_NOT_FOUND" });
      }
      const image = database
        .prepare(
          `SELECT original_mime, storage_driver, access_mode, original_path
           FROM images WHERE original_path = ? AND deleted_at IS NULL`,
        )
        .get(mediaPath) as unknown as
        | { original_mime: string; storage_driver: "local" | "s3"; access_mode: MediaAccessMode; original_path: string }
        | undefined;
      const variant = image
        ? undefined
        : database
          .prepare(
            `SELECT i.storage_driver, i.access_mode, v.path
             FROM variants v
             JOIN images i ON i.id = v.image_id
             WHERE v.path = ? AND v.status = 'ready' AND i.deleted_at IS NULL`,
          )
          .get(mediaPath) as unknown as
          | { storage_driver: "local" | "s3"; access_mode: MediaAccessMode; path: string }
          | undefined;
      const media = image
        ? {
          storageDriver: image.storage_driver,
          accessMode: image.access_mode,
          path: image.original_path,
          contentType: image.original_mime,
        }
        : variant
          ? {
            storageDriver: variant.storage_driver,
            accessMode: variant.access_mode,
            path: variant.path,
          }
          : undefined;
      if (!media) return reply.code(404).send({ status: "error", code: "MEDIA_NOT_FOUND" });
      return storage.sendProxy(media, reply);
    },
  );

  app.post(
    "/api/v1/images",
    { preHandler: requireAuthentication(database, { csrf: true }) },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(415).send({ status: "error", code: "MULTIPART_REQUIRED" });
      }

      const part = await request.file();
      if (!part) return reply.code(400).send({ status: "error", code: "IMAGE_REQUIRED" });

      const temporaryPath = join(directories.temporary, `${randomUUID()}.upload`);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let storedNewMedia: StoredMedia | undefined;
      let computedSha256: string | undefined;
      let storageDriver: "local" | "s3";
      let accessMode: MediaAccessMode;

      try {
        const fields = part.fields as Record<string, { value?: unknown } | undefined>;
        try {
          storageDriver = parseStorageField(fields.storage?.value, config.storageDriver);
          accessMode = parseAccessField(fields.access?.value, config.storageAccessMode);
        } catch (fieldError) {
          const code = fieldError instanceof Error ? fieldError.message : "INVALID_STORAGE_OPTIONS";
          return reply.code(400).send({ status: "error", code });
        }
        if (storageDriver === "s3" && !config.s3.bucket) {
          return reply.code(400).send({ status: "error", code: "S3_NOT_CONFIGURED" });
        }
        if (storageDriver === "local") accessMode = "direct";

        await pipeline(
          part.file,
          hashingTransform(hash, (size) => {
            sizeBytes += size;
          }),
          createWriteStream(temporaryPath, { flags: "wx" }),
        );
        if (part.file.truncated) {
          return reply.code(413).send({ status: "error", code: "FILE_TOO_LARGE" });
        }

        const fileHeader = Buffer.alloc(32);
        const temporaryFile = await open(temporaryPath, "r");
        let bytesRead = 0;
        try {
          ({ bytesRead } = await temporaryFile.read(fileHeader, 0, fileHeader.length, 0));
        } finally {
          await temporaryFile.close();
        }
        const detected = detectImageType(fileHeader.subarray(0, bytesRead));
        if (!detected) {
          return reply.code(415).send({ status: "error", code: "UNSUPPORTED_IMAGE_TYPE" });
        }

        let metadata: sharp.Metadata;
        try {
          metadata = await sharp(temporaryPath, {
            animated: true,
            limitInputPixels: config.maxInputPixels,
          }).metadata();
        } catch {
          return reply.code(422).send({ status: "error", code: "INVALID_IMAGE" });
        }
        if (!metadata.width || !metadata.height) {
          return reply.code(422).send({ status: "error", code: "INVALID_IMAGE" });
        }
        const compatibleFormats: Record<DetectedImageType["extension"], readonly string[]> = {
          jpg: ["jpeg"],
          png: ["png"],
          webp: ["webp"],
          gif: ["gif"],
          avif: ["heif", "avif"],
        };
        if (!metadata.format || !compatibleFormats[detected.extension].includes(metadata.format)) {
          return reply.code(422).send({ status: "error", code: "IMAGE_TYPE_MISMATCH" });
        }

        const sha256 = hash.digest("hex");
        computedSha256 = sha256;
        const duplicate = database
          .prepare("SELECT id FROM images WHERE sha256 = ? AND deleted_at IS NULL")
          .get(sha256) as unknown as { id: string } | undefined;
        if (duplicate) {
          const existingImage = getImage(database, duplicate.id);
          if (!existingImage) throw new Error("Duplicate image record disappeared");
          return reply.code(200).send({
            duplicate: true,
            image: serializeImage(database, storage, existingImage),
          });
        }

        const relativePath = posix.join(
          "originals",
          sha256.slice(0, 2),
          sha256.slice(2, 4),
          `${sha256}.${detected.extension}`,
        );
        storedFilePath(directories.root, relativePath);
        await storage.storeFile({
          storageDriver,
          accessMode,
          path: relativePath,
          sourcePath: temporaryPath,
          contentType: detected.mime,
          move: storageDriver === "local",
        });
        storedNewMedia = {
          storageDriver,
          accessMode,
          path: relativePath,
          contentType: detected.mime,
        };

        const imageId = ulid();
        const now = new Date().toISOString();
        const isAnimated = (metadata.pages ?? 1) > 1;
        const imageStatus = isAnimated ? "ready" : "pending";

        immediateTransaction(database, () => {
          database
            .prepare(
              `INSERT INTO images
                (id, sha256, original_name, original_mime, original_ext, original_path,
                 width, height, size_bytes, has_alpha, is_animated, status, storage_driver, access_mode,
                 created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              imageId,
              sha256,
              cleanOriginalName(part.filename),
              detected.mime,
              detected.extension,
              relativePath,
              metadata.width,
              metadata.height,
              sizeBytes,
              metadata.hasAlpha ? 1 : 0,
              isAnimated ? 1 : 0,
              imageStatus,
              storageDriver,
              accessMode,
              now,
              now,
            );

          if (!isAnimated) {
            for (const profile of ["display", "thumb"] as const) {
              for (const format of ["avif", "webp"] as const) {
                const variantPath = posix.join(
                  "variants",
                  sha256.slice(0, 2),
                  sha256.slice(2, 4),
                  sha256,
                  `${profile}.${format}`,
                );
                database
                  .prepare(
                    `INSERT INTO variants
                      (id, image_id, profile, format, path, status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
                  )
                  .run(ulid(), imageId, profile, format, variantPath, now, now);
              }
            }
            database
              .prepare(
                `INSERT INTO jobs
                  (id, type, image_id, state, attempts, available_at, created_at, updated_at)
                 VALUES (?, 'generate_variants', ?, 'pending', 0, ?, ?, ?)`,
              )
              .run(ulid(), imageId, now, now, now);
          }
        });

        const image = getImage(database, imageId);
        if (!image) throw new Error("Created image record not found");
        return reply.code(201).send({
          duplicate: false,
          image: serializeImage(database, storage, image),
        });
      } catch (error) {
        if (storedNewMedia) {
          const activeReference = database
            .prepare("SELECT id FROM images WHERE original_path = ? AND deleted_at IS NULL LIMIT 1")
            .get(storedNewMedia.path) as unknown as { id: string } | undefined;
          if (!activeReference) await storage.delete(storedNewMedia);
        }
        if (computedSha256 && isUniqueConstraintError(error)) {
          const duplicate = database
            .prepare("SELECT id FROM images WHERE sha256 = ? AND deleted_at IS NULL")
            .get(computedSha256) as unknown as { id: string } | undefined;
          if (duplicate) {
            const existingImage = getImage(database, duplicate.id);
            if (existingImage) {
              return reply.code(200).send({
                duplicate: true,
                image: serializeImage(database, storage, existingImage),
              });
            }
          }
        }
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    },
  );

  app.get(
    "/api/v1/images",
    { preHandler: requireAuthentication(database, { csrf: false }) },
    async () => {
      const images = database
        .prepare(
          `SELECT id, sha256, original_name, original_mime, original_path, width, height,
                  size_bytes, has_alpha, is_animated, status, storage_driver, access_mode,
                  created_at, updated_at
           FROM images WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
        )
        .all() as unknown as ImageRow[];
      return { items: images.map((image) => serializeImage(database, storage, image)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/images/:id",
    { preHandler: requireAuthentication(database, { csrf: false }) },
    async (request, reply) => {
      const image = getImage(database, request.params.id);
      if (!image) return reply.code(404).send({ status: "error", code: "IMAGE_NOT_FOUND" });
      return { image: serializeImage(database, storage, image) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/images/:id/retry",
    { preHandler: requireAuthentication(database, { csrf: true }) },
    async (request, reply) => {
      const image = getImage(database, request.params.id);
      if (!image) return reply.code(404).send({ status: "error", code: "IMAGE_NOT_FOUND" });
      if (image.is_animated === 1) {
        return reply.code(409).send({ status: "error", code: "ANIMATED_IMAGE_HAS_NO_VARIANTS" });
      }
      const now = new Date().toISOString();
      immediateTransaction(database, () => {
        database
          .prepare(
            "UPDATE variants SET status = 'pending', error = NULL, updated_at = ? WHERE image_id = ? AND status != 'ready'",
          )
          .run(now, image.id);
        database
          .prepare(
            `UPDATE jobs SET state = 'pending', attempts = 0, available_at = ?, lease_until = NULL,
               worker_id = NULL, last_error = NULL, updated_at = ? WHERE image_id = ?`,
          )
          .run(now, now, image.id);
        database.prepare("UPDATE images SET status = 'pending', updated_at = ? WHERE id = ?").run(now, image.id);
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/images/:id",
    { preHandler: requireAuthentication(database, { csrf: true }) },
    async (request, reply) => {
      const image = getImage(database, request.params.id);
      if (!image) return reply.code(404).send({ status: "error", code: "IMAGE_NOT_FOUND" });
      if (image.status === "processing") {
        return reply.code(409).send({ status: "error", code: "IMAGE_BUSY" });
      }
      const variants = database
        .prepare("SELECT path FROM variants WHERE image_id = ?")
        .all(image.id) as unknown as Array<{ path: string }>;
      const medias = [image.original_path, ...variants.map((variant) => variant.path)].map((path) => ({
        storageDriver: image.storage_driver,
        accessMode: image.access_mode,
        path,
      }));
      immediateTransaction(database, () => {
        database.prepare("DELETE FROM images WHERE id = ?").run(image.id);
      });
      await Promise.all(medias.map((media) => storage.delete(media)));
      return reply.code(204).send();
    },
  );
}

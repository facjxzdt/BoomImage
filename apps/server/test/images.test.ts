import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { MediaStorage, StoreFileOptions, StoredMedia } from "../src/storage.js";

const cleanupDirectories: string[] = [];
const password = "correct horse battery staple";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcwAAAABJRU5ErkJggg==",
  "base64",
);

class MemoryMediaStorage implements MediaStorage {
  readonly files = new Map<string, Buffer>();

  key(media: StoredMedia): string {
    return media.storageDriver === "s3"
      ? `s3:${media.s3?.bucket ?? "missing-bucket"}:${media.s3?.objectKey ?? media.path}`
      : `${media.storageDriver}:${media.path}`;
  }

  async storeFile(options: StoreFileOptions): Promise<void> {
    this.files.set(this.key(options), await readFile(options.sourcePath));
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    const content = this.files.get(this.key(media));
    if (!content) throw new Error("missing fake media");
    await writeFile(targetPath, content);
  }

  async delete(media: StoredMedia): Promise<void> {
    this.files.delete(this.key(media));
  }

  publicUrl(media: StoredMedia): string {
    return media.storageDriver === "s3"
      ? media.accessMode === "proxy"
        ? `https://img.example.test/media/proxy/${media.path}`
        : `${media.s3?.publicBaseUrl ?? "https://cdn.example.test"}/${media.s3?.objectKey ?? media.path}`
      : `https://img.example.test/media/${media.path}`;
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    const content = this.files.get(this.key(media));
    if (!content) {
      reply.code(404).send({ status: "error", code: "MEDIA_NOT_FOUND" });
      return;
    }
    reply
      .type(media.contentType ?? "application/octet-stream")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(content);
  }
}

class FailingDeleteMemoryStorage extends MemoryMediaStorage {
  async delete(_media: StoredMedia): Promise<void> {
    throw new Error("delete failed for test");
  }
}

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function authenticatedApp(storage?: MediaStorage) {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-images-test-"));
  cleanupDirectories.push(dataDir);
  const app = await buildApp({
    logger: false,
    ...(storage ? { storage } : {}),
    config: loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      APP_BASE_URL: "https://img.example.test",
      LOG_LEVEL: "silent",
    }),
  });
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password },
  });
  const setCookie = setup.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieValue) throw new Error("Expected a session cookie");
  return {
    app,
    dataDir,
    cookie: cookieValue.split(";", 1)[0] ?? "",
    csrfToken: setup.json().csrfToken as string,
  };
}

async function authenticatedLimitedUploadApp(maxUploadBytes: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-images-limit-test-"));
  cleanupDirectories.push(dataDir);
  const app = await buildApp({
    logger: false,
    config: loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      APP_BASE_URL: "https://img.example.test",
      MAX_UPLOAD_BYTES: String(maxUploadBytes),
      LOG_LEVEL: "silent",
    }),
  });
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password },
  });
  const setCookie = setup.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieValue) throw new Error("Expected a session cookie");
  return {
    app,
    cookie: cookieValue.split(";", 1)[0] ?? "",
    csrfToken: setup.json().csrfToken as string,
  };
}

async function authenticatedS3App(options: { s3Prefix?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-images-s3-test-"));
  cleanupDirectories.push(dataDir);
  const storage = new MemoryMediaStorage();
  const app = await buildApp({
    logger: false,
    storage,
    config: loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      APP_BASE_URL: "https://img.example.test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "boomimage-test",
      ...(options.s3Prefix ? { S3_PREFIX: options.s3Prefix } : {}),
      S3_PUBLIC_BASE_URL: "https://cdn.example.test",
      LOG_LEVEL: "silent",
    }),
  });
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password },
  });
  const setCookie = setup.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieValue) throw new Error("Expected a session cookie");
  return {
    app,
    storage,
    cookie: cookieValue.split(";", 1)[0] ?? "",
    csrfToken: setup.json().csrfToken as string,
  };
}

function multipartImage(image: Buffer, filename = "pixel.png", fields: Record<string, string> = {}) {
  const boundary = `boomimage-${Date.now()}`;
  const fieldBuffers = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
  );
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([...fieldBuffers, prefix, image, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("image upload", () => {
  it("streams, validates and deduplicates an uploaded image", async () => {
    const { app, cookie, csrfToken, dataDir } = await authenticatedApp();
    const multipart = multipartImage(onePixelPng);

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().duplicate).toBe(false);
    expect(upload.json().image).toMatchObject({
      mime: "image/png",
      width: 1,
      height: 1,
      status: "pending",
    });
    const originalPath = new URL(upload.json().image.originalUrl as string).pathname;
    expect(upload.json().image.variants).toHaveLength(4);

    const duplicateMultipart = multipartImage(onePixelPng, "another-name.png");
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": duplicateMultipart.contentType,
      },
      payload: duplicateMultipart.payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(duplicate.json().image.id).toBe(upload.json().image.id);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/images",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/images/${upload.json().image.id as string}`,
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(deletion.statusCode).toBe(204);
    const deletedMedia = await app.inject({ method: "GET", url: originalPath });
    expect(deletedMedia.statusCode).toBe(404);
    const emptyList = await app.inject({
      method: "GET",
      url: "/api/v1/images",
      headers: { cookie },
    });
    expect(emptyList.json().items).toHaveLength(0);

    const uploadedAgainMultipart = multipartImage(onePixelPng, "same-file.png");
    const uploadedAgain = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": uploadedAgainMultipart.contentType,
      },
      payload: uploadedAgainMultipart.payload,
    });
    expect(uploadedAgain.statusCode).toBe(201);
    expect(uploadedAgain.json().duplicate).toBe(false);
    await app.close();
  });

  it("keeps failed physical deletions retryable and does not permanently block duplicates", async () => {
    const { app, cookie, csrfToken, dataDir } = await authenticatedApp(new FailingDeleteMemoryStorage());
    const multipart = multipartImage(onePixelPng);

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(201);

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/images/${upload.json().image.id as string}`,
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(deletion.statusCode).toBe(202);
    expect(deletion.json()).toEqual({ accepted: true, cleanup: "pending" });

    const database = new DatabaseSync(join(dataDir, "boomimage.db"));
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const softDeletedImage = database
        .prepare("SELECT deleted_at FROM images WHERE id = ?")
        .get(upload.json().image.id as string) as unknown as { deleted_at: string | null };
      const deleteJob = database
        .prepare("SELECT type, state, last_error FROM jobs WHERE image_id = ? AND type = 'delete_files'")
        .get(upload.json().image.id as string) as unknown as { type: string; state: string; last_error: string | null };
      expect(softDeletedImage.deleted_at).not.toBeNull();
      expect(deleteJob).toMatchObject({ type: "delete_files", state: "pending" });
      expect(deleteJob.last_error).toContain("delete failed for test");
      database
        .prepare(
          `UPDATE jobs
           SET state = 'failed', attempts = 3, lease_until = NULL, worker_id = NULL,
               last_error = 'delete failed for test', updated_at = ?
           WHERE image_id = ? AND type = 'delete_files'`,
        )
        .run(new Date().toISOString(), upload.json().image.id as string);
    } finally {
      database.close();
    }

    const failedDuplicateMultipart = multipartImage(onePixelPng, "failed-delete.png");
    const failedDuplicate = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": failedDuplicateMultipart.contentType,
      },
      payload: failedDuplicateMultipart.payload,
    });
    expect(failedDuplicate.statusCode).toBe(409);
    expect(failedDuplicate.json().code).toBe("IMAGE_DELETE_REQUEUED");

    const requeuedDatabase = new DatabaseSync(join(dataDir, "boomimage.db"));
    try {
      const requeuedJob = requeuedDatabase
        .prepare("SELECT state, attempts, last_error FROM jobs WHERE image_id = ? AND type = 'delete_files'")
        .get(upload.json().image.id as string) as unknown as { state: string; attempts: number; last_error: string | null };
      expect(requeuedJob).toEqual({ state: "pending", attempts: 0, last_error: null });
    } finally {
      requeuedDatabase.close();
    }
    await app.close();
  });

  it("rejects unauthenticated and unsupported uploads", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const multipart = multipartImage(Buffer.from("not an image"), "fake.png");

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: { "content-type": multipart.contentType },
      payload: multipart.payload,
    });
    expect(unauthenticated.statusCode).toBe(403);

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().code).toBe("UNSUPPORTED_IMAGE_TYPE");

    const corruptedMultipart = multipartImage(
      Buffer.concat([onePixelPng.subarray(0, 8), Buffer.from("corrupted-image-data")]),
      "corrupted.png",
    );
    const corrupted = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": corruptedMultipart.contentType,
      },
      payload: corruptedMultipart.payload,
    });
    expect(corrupted.statusCode).toBe(422);
    expect(corrupted.json().code).toBe("INVALID_IMAGE");
    await app.close();
  });

  it("rejects uploads as soon as they exceed the configured runtime size limit", async () => {
    const { app, cookie, csrfToken } = await authenticatedLimitedUploadApp(64);
    const multipart = multipartImage(onePixelPng, "pixel.png");

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(413);
    expect(upload.json().code).toBe("FILE_TOO_LARGE");
    await app.close();
  });

  it("accepts S3 direct and proxy storage choices for new uploads", async () => {
    const { app, cookie, csrfToken, storage } = await authenticatedS3App();
    const directMultipart = multipartImage(onePixelPng, "pixel.png", {
      storage: "s3",
      access: "direct",
    });

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": directMultipart.contentType,
      },
      payload: directMultipart.payload,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().image).toMatchObject({
      storageDriver: "s3",
      accessMode: "direct",
    });
    expect(upload.json().image.originalUrl).toMatch(/^https:\/\/cdn\.example\.test\/originals\//);
    expect(storage.files.size).toBe(1);

    await app.close();
  });

  it("serves S3 proxy media publicly only for known database paths", async () => {
    const { app, cookie, csrfToken } = await authenticatedS3App();
    try {
      const proxyMultipart = multipartImage(onePixelPng, "pixel.png", {
        storage: "s3",
        access: "proxy",
      });

      const upload = await app.inject({
        method: "POST",
        url: "/api/v1/images",
        headers: {
          cookie,
          "x-csrf-token": csrfToken,
          "content-type": proxyMultipart.contentType,
        },
        payload: proxyMultipart.payload,
      });
      expect(upload.statusCode).toBe(201);
      expect(upload.json().image).toMatchObject({
        storageDriver: "s3",
        accessMode: "proxy",
      });

      const proxyPath = new URL(upload.json().image.originalUrl as string).pathname;
      const media = await app.inject({ method: "GET", url: proxyPath });
      expect(media.statusCode).toBe(200);
      expect(media.headers["cache-control"]).toContain("immutable");
      expect(media.rawPayload).toEqual(onePixelPng);

      const unknown = await app.inject({
        method: "GET",
        url: "/media/proxy/originals/00/00/not-in-database.png",
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keeps S3 object locations stable after runtime S3 settings change", async () => {
    const { app, cookie, csrfToken, storage } = await authenticatedS3App({ s3Prefix: "old-prefix" });
    try {
      const directMultipart = multipartImage(onePixelPng, "pixel.png", {
        storage: "s3",
        access: "direct",
      });

      const upload = await app.inject({
        method: "POST",
        url: "/api/v1/images",
        headers: {
          cookie,
          "x-csrf-token": csrfToken,
          "content-type": directMultipart.contentType,
        },
        payload: directMultipart.payload,
      });
      expect(upload.statusCode).toBe(201);
      const originalUrl = upload.json().image.originalUrl as string;
      expect(originalUrl).toContain("https://cdn.example.test/old-prefix/originals/");
      expect([...storage.files.keys()].some((key) => key.includes(":old-prefix/originals/"))).toBe(true);

      const settings = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: {
          cookie,
          "x-csrf-token": csrfToken,
        },
        payload: {
          s3: {
            bucket: "new-bucket",
            prefix: "new-prefix",
            publicBaseUrl: "https://new-cdn.example.test",
          },
        },
      });
      expect(settings.statusCode).toBe(200);

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/images/${upload.json().image.id as string}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().image.originalUrl).toBe(originalUrl);
      expect(detail.json().image.originalUrl).not.toContain("new-prefix");
      expect(detail.json().image.originalUrl).not.toContain("new-cdn.example.test");

      const deletion = await app.inject({
        method: "DELETE",
        url: `/api/v1/images/${upload.json().image.id as string}`,
        headers: { cookie, "x-csrf-token": csrfToken },
      });
      expect(deletion.statusCode).toBe(204);
      expect([...storage.files.keys()].some((key) => key.includes(":old-prefix/originals/"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid storage fields", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const multipart = multipartImage(onePixelPng, "pixel.png", {
      storage: "ftp",
    });

    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().code).toBe("INVALID_STORAGE_DRIVER");
    await app.close();
  });
});

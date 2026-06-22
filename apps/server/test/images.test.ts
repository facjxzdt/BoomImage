import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  async storeFile(options: StoreFileOptions): Promise<void> {
    this.files.set(`${options.storageDriver}:${options.path}`, await readFile(options.sourcePath));
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    const content = this.files.get(`${media.storageDriver}:${media.path}`);
    if (!content) throw new Error("missing fake media");
    await writeFile(targetPath, content);
  }

  async delete(media: StoredMedia): Promise<void> {
    this.files.delete(`${media.storageDriver}:${media.path}`);
  }

  publicUrl(media: StoredMedia): string {
    return media.storageDriver === "s3"
      ? media.accessMode === "proxy"
        ? `https://img.example.test/media/proxy/${media.path}`
        : `https://cdn.example.test/${media.path}`
      : `https://img.example.test/media/${media.path}`;
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    const content = this.files.get(`${media.storageDriver}:${media.path}`);
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

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function authenticatedApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-images-test-"));
  cleanupDirectories.push(dataDir);
  const app = await buildApp({
    logger: false,
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
    cookie: cookieValue.split(";", 1)[0] ?? "",
    csrfToken: setup.json().csrfToken as string,
  };
}

async function authenticatedS3App() {
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
    const { app, cookie, csrfToken } = await authenticatedApp();
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
    const emptyList = await app.inject({
      method: "GET",
      url: "/api/v1/images",
      headers: { cookie },
    });
    expect(emptyList.json().items).toHaveLength(0);
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

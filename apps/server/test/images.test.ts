import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cleanupDirectories: string[] = [];
const password = "correct horse battery staple";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcwAAAABJRU5ErkJggg==",
  "base64",
);

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

function multipartImage(image: Buffer, filename = "pixel.png") {
  const boundary = `boomimage-${Date.now()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([prefix, image, suffix]),
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
});

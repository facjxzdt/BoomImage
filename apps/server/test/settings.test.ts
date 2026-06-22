import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cleanupDirectories: string[] = [];
const password = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function authenticatedApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-settings-test-"));
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

describe("runtime settings", () => {
  it("returns and updates editable runtime settings", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      baseUrl: "https://img.example.test",
      storageDriver: "local",
    });

    const update = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
      },
      payload: {
        baseUrl: "https://images.example.test/",
        maxUploadBytes: 10_485_760,
        maxInputPixels: 25_000_000,
        jobLeaseSeconds: 600,
        jobMaxAttempts: 4,
        avifQuality: 55,
        avifEffort: 5,
        webpQuality: 84,
        storageDriver: "s3",
        storageAccessMode: "direct",
        s3: {
          endpoint: "https://s3.example.test/",
          region: "auto",
          bucket: "boomimage",
          prefix: "/uploads/",
          publicBaseUrl: "https://cdn.example.test/",
          forcePathStyle: true,
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
          sessionToken: "session-token",
        },
      },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject({
      baseUrl: "https://images.example.test",
      maxUploadBytes: 10_485_760,
      maxInputPixels: 25_000_000,
      jobLeaseSeconds: 600,
      jobMaxAttempts: 4,
      avifQuality: 55,
      avifEffort: 5,
      webpQuality: 84,
      storageDriver: "s3",
      storageAccessMode: "direct",
      s3: {
        endpoint: "https://s3.example.test",
        region: "auto",
        bucket: "boomimage",
        prefix: "uploads",
        publicBaseUrl: "https://cdn.example.test",
        forcePathStyle: true,
        accessKeyId: "access-key",
        secretAccessKeyConfigured: true,
        sessionTokenConfigured: true,
      },
    });
    expect(JSON.stringify(update.json())).not.toContain("secret-key");
    expect(JSON.stringify(update.json())).not.toContain("session-token");

    const reloaded = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie },
    });
    expect(reloaded.json().settings.s3.secretAccessKeyConfigured).toBe(true);
    await app.close();
  });

  it("rejects invalid updates and keeps the previous settings", async () => {
    const { app, cookie, csrfToken } = await authenticatedApp();
    const accepted = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
      },
      payload: {
        baseUrl: "https://images.example.test",
      },
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
      },
      payload: {
        storageDriver: "s3",
        s3: { bucket: "" },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("INVALID_SETTINGS");

    const current = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: { cookie },
    });
    expect(current.json().settings).toMatchObject({
      baseUrl: "https://images.example.test",
      storageDriver: "local",
    });
    await app.close();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function testConfig() {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-test-"));
  cleanupDirectories.push(dataDir);
  return loadConfig({
    APP_DATA_DIR: dataDir,
    MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
    LOG_LEVEL: "silent",
  });
}

async function httpsTestConfig() {
  const config = await testConfig();
  config.baseUrl = "https://img.example.test";
  return config;
}

async function webDistFixture(): Promise<string> {
  const webDistDir = await mkdtemp(join(tmpdir(), "boomimage-web-dist-test-"));
  cleanupDirectories.push(webDistDir);
  await mkdir(join(webDistDir, "assets"));
  await writeFile(
    join(webDistDir, "index.html"),
    '<!doctype html><html><head><title>BoomImage</title><link rel="stylesheet" href="/assets/index.css"></head><body>BoomImage</body></html>',
    "utf8",
  );
  await writeFile(join(webDistDir, "assets", "index.css"), ":root { --surface: #ffffff; }", "utf8");
  return webDistDir;
}

describe("BoomImage application", () => {
  it("reports liveness", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("sets baseline security headers without HSTS on HTTP base URLs", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    await app.close();
  });

  it("sets HSTS when the public base URL is HTTPS", async () => {
    const app = await buildApp({ config: await httpsTestConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
    await app.close();
  });

  it("allows configured S3 direct image origins in CSP", async () => {
    const config = await testConfig();
    config.s3.bucket = "boomimage-test";
    config.s3.region = "auto";
    config.s3.endpoint = "https://s3.example.test";
    config.s3.publicBaseUrl = "https://cdn.example.test";
    const app = await buildApp({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["content-security-policy"]).toContain("https://cdn.example.test");
    expect(response.headers["content-security-policy"]).toContain("https://s3.example.test");
    await app.close();
  });

  it("allows historical S3 direct image origins from stored snapshots in CSP", async () => {
    const config = await testConfig();
    config.s3.bucket = "new-bucket";
    config.s3.region = "auto";
    config.s3.publicBaseUrl = "https://new-cdn.example.test";
    const app = await buildApp({ config, logger: false });
    const database = new DatabaseSync(config.databasePath);
    try {
      const now = new Date().toISOString();
      database.exec("PRAGMA busy_timeout = 5000");
      database
        .prepare(
          `INSERT INTO images
            (id, sha256, original_name, original_mime, original_ext, original_path,
             width, height, size_bytes, has_alpha, is_animated, status, storage_driver, access_mode,
             s3_bucket, s3_object_key, s3_endpoint, s3_region, s3_public_base_url, s3_force_path_style,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "historical-s3-image",
          "0".repeat(64),
          "old.png",
          "image/png",
          "png",
          "originals/00/00/old.png",
          1,
          1,
          1,
          0,
          0,
          "ready",
          "s3",
          "direct",
          "old-bucket",
          "old-prefix/originals/00/00/old.png",
          "https://old-s3.example.test",
          "auto",
          "https://old-cdn.example.test",
          1,
          now,
          now,
        );
    } finally {
      database.close();
    }

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.headers["content-security-policy"]).toContain("https://new-cdn.example.test");
    expect(response.headers["content-security-policy"]).toContain("https://old-cdn.example.test");
    expect(response.headers["content-security-policy"]).toContain("https://old-s3.example.test");
    await app.close();
  });

  it("allows public media to be embedded cross-origin", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/media/proxy/not-found.webp" });

    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    await app.close();
  });

  it("reports readiness after preparing the database and data directory", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("sanitizes unexpected error responses", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    app.get("/test/internal-error", async () => {
      throw new Error("C:\\Users\\facjx\\Desktop\\BoomImage\\data\\secret-token");
    });
    const response = await app.inject({ method: "GET", url: "/test/internal-error" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ status: "error", code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("BoomImage");
    expect(response.body).not.toContain("secret-token");
    await app.close();
  });

  it("serves the built management interface when a web distribution exists", async () => {
    const config = await testConfig();
    config.webDistDir = await webDistFixture();
    const app = await buildApp({ config, logger: false, startWorkers: false });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("BoomImage");
    await app.close();
  });

  it("serves built management interface assets", async () => {
    const config = await testConfig();
    config.webDistDir = await webDistFixture();
    const app = await buildApp({ config, logger: false, startWorkers: false });
    const index = await app.inject({ method: "GET", url: "/" });
    const assetPath = index.body.match(/href="([^"]+\.css)"/)?.[1];

    expect(assetPath).toEqual(expect.any(String));
    if (!assetPath) throw new Error("Expected built CSS asset path");
    const asset = await app.inject({ method: "GET", url: assetPath });

    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/css");
    expect(asset.body).toContain("--surface");
    await app.close();
  });
});

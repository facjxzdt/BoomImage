import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("reports readiness after preparing the database and data directory", async () => {
    const app = await buildApp({ config: await testConfig(), logger: false });
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
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

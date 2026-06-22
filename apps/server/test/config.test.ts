import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("rejects invalid integer values", () => {
    expect(() => loadConfig({ APP_PORT: "invalid" })).toThrow(/APP_PORT/);
    expect(() => loadConfig({ AVIF_QUALITY: "101" })).toThrow(/AVIF_QUALITY/);
    expect(() => loadConfig({ TMP_FILE_TTL_SECONDS: "60" })).toThrow(/TMP_FILE_TTL_SECONDS/);
  });

  it("normalizes the public base URL", () => {
    expect(loadConfig({ APP_BASE_URL: "https://img.example.com/" }).baseUrl).toBe(
      "https://img.example.com",
    );
  });

  it("resolves default project paths from the workspace root", () => {
    const config = loadConfig({});

    expect(config.migrationsDir.replaceAll("\\", "/")).toMatch(/BoomImage\/migrations$/);
    expect(config.webDistDir.replaceAll("\\", "/")).toMatch(/BoomImage\/apps\/web\/dist$/);
  });

  it("loads temporary cleanup settings", () => {
    const config = loadConfig({
      TMP_FILE_TTL_SECONDS: "7200",
      TMP_CLEANUP_INTERVAL_SECONDS: "0",
    });

    expect(config.tmpFileTtlSeconds).toBe(7_200);
    expect(config.tmpCleanupIntervalSeconds).toBe(0);
  });

  it("loads S3 storage settings", () => {
    const config = loadConfig({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "boomimage",
      S3_ENDPOINT: "https://s3.example.test",
      S3_REGION: "auto",
      S3_PREFIX: "/uploads/",
      S3_PUBLIC_BASE_URL: "https://cdn.example.test/",
      S3_FORCE_PATH_STYLE: "true",
    });

    expect(config.storageDriver).toBe("s3");
    expect(config.s3).toMatchObject({
      bucket: "boomimage",
      endpoint: "https://s3.example.test",
      region: "auto",
      prefix: "uploads",
      publicBaseUrl: "https://cdn.example.test",
      forcePathStyle: true,
    });
  });

  it("requires a bucket when S3 is the default storage driver", () => {
    expect(() => loadConfig({ STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
  });
});

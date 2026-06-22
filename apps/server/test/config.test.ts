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
});

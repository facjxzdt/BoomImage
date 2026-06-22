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

async function createTestApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-auth-test-"));
  cleanupDirectories.push(dataDir);
  return buildApp({
    logger: false,
    config: loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      LOG_LEVEL: "silent",
    }),
  });
}

async function createRateLimitedTestApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "boomimage-auth-rate-limit-test-"));
  cleanupDirectories.push(dataDir);
  return buildApp({
    logger: false,
    config: loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: "2",
      AUTH_RATE_LIMIT_WINDOW_MS: "60000",
      LOG_LEVEL: "silent",
    }),
  });
}

function cookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string {
  const value = response.headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : value;
  if (typeof cookie !== "string") throw new Error("Expected a session cookie");
  return cookie.split(";", 1)[0] ?? "";
}

describe("administrator authentication", () => {
  it("initializes once and creates an authenticated session", async () => {
    const app = await createTestApp();

    const initialStatus = await app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(initialStatus.json()).toEqual({ initialized: false });

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password },
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.json().csrfToken).toBeTypeOf("string");
    const setCookies = setup.headers["set-cookie"];
    const cookieHeaders = Array.isArray(setCookies) ? setCookies : [setCookies];
    const csrfCookie = cookieHeaders.find((value) => value?.startsWith("boomimage_csrf="));
    expect(csrfCookie).toBeTypeOf("string");
    expect(csrfCookie).not.toContain("HttpOnly");

    const cookie = cookieFrom(setup);
    expect(cookie).toContain(".");
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ authenticated: true });

    const secondSetup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password },
    });
    expect(secondSetup.statusCode).toBe(409);
    await app.close();
  });

  it("rejects tampered signed session cookies", async () => {
    const app = await createTestApp();
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password },
    });
    const cookie = cookieFrom(setup);
    const tamperedCookie = `${cookie}x`;
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: tamperedCookie },
    });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("requires valid credentials and CSRF for state-changing session actions", async () => {
    const app = await createTestApp();
    await app.inject({ method: "POST", url: "/api/v1/auth/setup", payload: { password } });

    const rejectedLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "this password is incorrect" },
    });
    expect(rejectedLogin.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password },
    });
    const cookie = cookieFrom(login);
    const csrfToken = login.json().csrfToken as string;

    const rejectedLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, "x-csrf-token": "wrong-token" },
    });
    expect(rejectedLogout.statusCode).toBe(403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    await app.close();
  });

  it("rate limits repeated login attempts per client address", async () => {
    const app = await createRateLimitedTestApp();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { password: "this password is incorrect" },
        });
        expect(response.statusCode).toBe(409);
      }

      const limitedBeforeSetup = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { password: "this password is incorrect" },
      });
      expect(limitedBeforeSetup.statusCode).toBe(429);
      expect(limitedBeforeSetup.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("creates revocable API tokens without allowing token self-management", async () => {
    const app = await createTestApp();
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { password },
    });
    const cookie = cookieFrom(setup);
    const csrfToken = setup.json().csrfToken as string;
    const creation = await app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { name: "Upload client", expiresInDays: 30 },
    });
    expect(creation.statusCode).toBe(201);
    const rawToken = creation.json().token as string;
    const tokenId = creation.json().id as string;
    expect(rawToken).toMatch(/^bi_/);

    const bearerHeaders = { authorization: `Bearer ${rawToken}` };
    const imageList = await app.inject({ method: "GET", url: "/api/v1/images", headers: bearerHeaders });
    expect(imageList.statusCode).toBe(200);
    const tokenListWithToken = await app.inject({ method: "GET", url: "/api/v1/tokens", headers: bearerHeaders });
    expect(tokenListWithToken.statusCode).toBe(401);

    const revocation = await app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${tokenId}`,
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    expect(revocation.statusCode).toBe(204);
    const rejected = await app.inject({ method: "GET", url: "/api/v1/images", headers: bearerHeaders });
    expect(rejected.statusCode).toBe(401);
    await app.close();
  });
});

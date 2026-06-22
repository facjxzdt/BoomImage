import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { immediateTransaction, type AppDatabase } from "./database.js";

const SESSION_COOKIE = "boomimage_session";
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

interface PasswordBody {
  password: string;
}

interface SessionRow {
  csrf_hash: string;
  expires_at: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class AuthRateLimiter {
  readonly #entries = new Map<string, RateLimitEntry>();
  readonly #windowMs: number;
  readonly #maxAttempts: number;

  constructor(windowMs: number, maxAttempts: number) {
    this.#windowMs = windowMs;
    this.#maxAttempts = maxAttempts;
  }

  consume(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true };
    }

    if (current.count >= this.#maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      };
    }

    current.count += 1;
    return { allowed: true };
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}

export interface AuthContext {
  kind: "session" | "api-token";
  credentialHash: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function passwordOptions() {
  return {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  } as const;
}

function isInitialized(database: AppDatabase): boolean {
  return database.prepare("SELECT 1 FROM administrator WHERE id = 1").get() !== undefined;
}

function authRateLimitKey(request: FastifyRequest, action: "setup" | "login"): string {
  return `${action}:${request.ip}`;
}

function rejectRateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .code(429)
    .header("Retry-After", String(retryAfterSeconds))
    .send({ status: "error", code: "AUTH_RATE_LIMITED" });
}

function setSessionCookies(
  reply: FastifyReply,
  token: string,
  csrfToken: string,
  config: AppConfig,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.baseUrl.startsWith("https://"),
    sameSite: "strict",
    maxAge: config.sessionTtlSeconds,
  });
  reply.setCookie("boomimage_csrf", csrfToken, {
    path: "/",
    httpOnly: false,
    secure: config.baseUrl.startsWith("https://"),
    sameSite: "strict",
    maxAge: config.sessionTtlSeconds,
  });
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: config.baseUrl.startsWith("https://"),
    sameSite: "strict",
  });
  reply.clearCookie("boomimage_csrf", {
    path: "/",
    httpOnly: false,
    secure: config.baseUrl.startsWith("https://"),
    sameSite: "strict",
  });
}

function createSession(database: AppDatabase, config: AppConfig) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1_000);

  immediateTransaction(database, () => {
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
    database
      .prepare(
        `INSERT INTO sessions
          (token_hash, csrf_hash, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        digest(token),
        digest(csrfToken),
        expiresAt.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
  });

  return { token, csrfToken, expiresAt: expiresAt.toISOString() };
}

export function authenticateRequest(
  database: AppDatabase,
  request: FastifyRequest,
  requireCsrf: boolean,
  allowApiToken = true,
): AuthContext | undefined {
  const authorization = request.headers.authorization;
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (allowApiToken && bearerMatch?.[1]) {
    const rawToken = bearerMatch[1].trim();
    if (!rawToken.startsWith("bi_") || rawToken.length < 40) return undefined;
    const tokenHash = digest(rawToken);
    const token = database
      .prepare(
        `SELECT expires_at FROM api_tokens
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .get(tokenHash) as unknown as { expires_at: string | null } | undefined;
    if (!token || (token.expires_at !== null && Date.parse(token.expires_at) <= Date.now())) {
      return undefined;
    }
    database
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
      .run(new Date().toISOString(), tokenHash);
    return { kind: "api-token", credentialHash: tokenHash };
  }

  const token = request.cookies[SESSION_COOKIE];
  if (!token) return undefined;

  const tokenHash = digest(token);
  const session = database
    .prepare("SELECT csrf_hash, expires_at FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as unknown as SessionRow | undefined;

  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    if (session) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return undefined;
  }

  if (requireCsrf) {
    const csrfToken = request.headers["x-csrf-token"];
    if (typeof csrfToken !== "string" || !safeDigestEqual(digest(csrfToken), session.csrf_hash)) {
      return undefined;
    }
  }

  database
    .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), tokenHash);
  return { kind: "session", credentialHash: tokenHash };
}

export function requireAuthentication(
  database: AppDatabase,
  options: { csrf: boolean; allowApiToken?: boolean },
) {
  return async function authenticationHook(request: FastifyRequest, reply: FastifyReply) {
    const context = authenticateRequest(
      database,
      request,
      options.csrf,
      options.allowApiToken ?? true,
    );
    if (!context) {
      return reply.code(options.csrf ? 403 : 401).send({
        status: "error",
        code: options.csrf ? "INVALID_CSRF_OR_SESSION" : "UNAUTHENTICATED",
      });
    }
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  config: AppConfig,
): void {
  const authRateLimiter = new AuthRateLimiter(
    config.authRateLimitWindowMs,
    config.authRateLimitMaxAttempts,
  );
  const passwordSchema = {
    type: "object",
    additionalProperties: false,
    required: ["password"],
    properties: {
      password: { type: "string", minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH },
    },
  } as const;

  app.get("/api/v1/auth/status", async () => ({ initialized: isInitialized(database) }));

  app.post<{ Body: PasswordBody }>(
    "/api/v1/auth/setup",
    { schema: { body: passwordSchema } },
    async (request, reply) => {
      const rateLimitKey = authRateLimitKey(request, "setup");
      const rateLimit = authRateLimiter.consume(rateLimitKey);
      if (!rateLimit.allowed) return rejectRateLimited(reply, rateLimit.retryAfterSeconds);

      if (isInitialized(database)) {
        return reply.code(409).send({ status: "error", code: "ALREADY_INITIALIZED" });
      }

      const passwordHash = await hash(request.body.password, passwordOptions());
      const now = new Date().toISOString();
      try {
        database
          .prepare(
            "INSERT INTO administrator (id, password_hash, initialized_at, updated_at) VALUES (1, ?, ?, ?)",
          )
          .run(passwordHash, now, now);
      } catch (error) {
        if (isInitialized(database)) {
          return reply.code(409).send({ status: "error", code: "ALREADY_INITIALIZED" });
        }
        throw error;
      }

      const session = createSession(database, config);
      authRateLimiter.reset(rateLimitKey);
      setSessionCookies(reply, session.token, session.csrfToken, config);
      return reply.code(201).send({
        initialized: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      });
    },
  );

  app.post<{ Body: PasswordBody }>(
    "/api/v1/auth/login",
    { schema: { body: passwordSchema } },
    async (request, reply) => {
      const rateLimitKey = authRateLimitKey(request, "login");
      const rateLimit = authRateLimiter.consume(rateLimitKey);
      if (!rateLimit.allowed) return rejectRateLimited(reply, rateLimit.retryAfterSeconds);

      const credential = database
        .prepare("SELECT password_hash FROM administrator WHERE id = 1")
        .get() as unknown as { password_hash: string } | undefined;

      if (!credential) {
        return reply.code(409).send({ status: "error", code: "NOT_INITIALIZED" });
      }

      if (!(await verify(credential.password_hash, request.body.password, passwordOptions()))) {
        return reply.code(401).send({ status: "error", code: "INVALID_CREDENTIALS" });
      }

      const session = createSession(database, config);
      authRateLimiter.reset(rateLimitKey);
      setSessionCookies(reply, session.token, session.csrfToken, config);
      return {
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    },
  );

  app.get(
    "/api/v1/auth/me",
    { preHandler: requireAuthentication(database, { csrf: false, allowApiToken: false }) },
    async () => ({ authenticated: true }),
  );

  app.post(
    "/api/v1/auth/logout",
    { preHandler: requireAuthentication(database, { csrf: true, allowApiToken: false }) },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest(token));
      clearSessionCookie(reply, config);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/tokens",
    { preHandler: requireAuthentication(database, { csrf: false, allowApiToken: false }) },
    async () => ({
      items: database
        .prepare(
          `SELECT id, name, last_used_at AS lastUsedAt, expires_at AS expiresAt,
                  created_at AS createdAt, revoked_at AS revokedAt
           FROM api_tokens ORDER BY created_at DESC`,
        )
        .all(),
    }),
  );

  app.post<{ Body: { name: string; expiresInDays?: number } }>(
    "/api/v1/tokens",
    {
      preHandler: requireAuthentication(database, { csrf: true, allowApiToken: false }),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            expiresInDays: { type: "integer", minimum: 1, maximum: 3_650 },
          },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ status: "error", code: "TOKEN_NAME_REQUIRED" });
      const token = `bi_${randomBytes(32).toString("base64url")}`;
      const now = new Date();
      const expiresAt = request.body.expiresInDays
        ? new Date(now.getTime() + request.body.expiresInDays * 86_400_000).toISOString()
        : null;
      const id = randomBytes(16).toString("hex");
      database
        .prepare(
          `INSERT INTO api_tokens (id, name, token_hash, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, name, digest(token), expiresAt, now.toISOString());
      return reply.code(201).send({ id, name, token, expiresAt });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/tokens/:id",
    { preHandler: requireAuthentication(database, { csrf: true, allowApiToken: false }) },
    async (request, reply) => {
      const result = database
        .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), request.params.id);
      if (result.changes === 0) {
        return reply.code(404).send({ status: "error", code: "TOKEN_NOT_FOUND" });
      }
      return reply.code(204).send();
    },
  );
}

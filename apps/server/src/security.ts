import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Content-Security-Policy", contentSecurityPolicy);
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");

    if (config.baseUrl.startsWith("https://")) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}


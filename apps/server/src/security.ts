import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

function urlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function s3ImageOrigins(config: AppConfig): string[] {
  const origins = new Set<string>();
  const addOrigin = (value: string | undefined) => {
    const origin = urlOrigin(value);
    if (origin) origins.add(origin);
  };

  addOrigin(config.s3.publicBaseUrl);
  addOrigin(config.s3.endpoint);
  if (config.s3.bucket) {
    addOrigin(`https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com`);
  }

  return Array.from(origins);
}

function contentSecurityPolicy(config: AppConfig): string {
  const imageSources = ["'self'", "data:", "blob:", ...s3ImageOrigins(config)].join(" ");

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  app.addHook("onRequest", async (request, reply) => {
    const isPublicMediaRequest = request.url.startsWith("/media/");

    reply.header("Content-Security-Policy", contentSecurityPolicy(config));
    reply.header("Cross-Origin-Resource-Policy", isPublicMediaRequest ? "cross-origin" : "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");

    if (config.baseUrl.startsWith("https://")) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}

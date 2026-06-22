import type { ImageItem } from "./types";

interface ApiErrorBody {
  code?: string;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(response.status, body.code ?? "REQUEST_FAILED");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function csrfToken(): string {
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("boomimage_csrf="));
  return entry ? decodeURIComponent(entry.slice("boomimage_csrf=".length)) : "";
}

export const api = {
  authStatus: () => jsonRequest<{ initialized: boolean }>("/api/v1/auth/status"),
  me: () => jsonRequest<{ authenticated: boolean }>("/api/v1/auth/me"),
  setup: (password: string) =>
    jsonRequest<{ initialized: true; csrfToken: string }>("/api/v1/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  login: (password: string) =>
    jsonRequest<{ authenticated: true; csrfToken: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () =>
    jsonRequest<void>("/api/v1/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken() },
    }),
  images: () => jsonRequest<{ items: ImageItem[] }>("/api/v1/images"),
  retryImage: (id: string) =>
    jsonRequest<{ accepted: true }>(`/api/v1/images/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken() },
    }),
  deleteImage: (id: string) =>
    jsonRequest<void>(`/api/v1/images/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrfToken() },
    }),
  tokens: () =>
    jsonRequest<{
      items: Array<{
        id: string;
        name: string;
        lastUsedAt: string | null;
        expiresAt: string | null;
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>("/api/v1/tokens"),
  createToken: (name: string, expiresInDays?: number) =>
    jsonRequest<{ id: string; name: string; token: string; expiresAt: string | null }>("/api/v1/tokens", {
      method: "POST",
      headers: { "x-csrf-token": csrfToken() },
      body: JSON.stringify({ name, ...(expiresInDays ? { expiresInDays } : {}) }),
    }),
  revokeToken: (id: string) =>
    jsonRequest<void>(`/api/v1/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrfToken() },
    }),
};

export function uploadImage(
  file: File,
  onProgress: (percentage: number) => void,
  options: { storageDriver?: "local" | "s3"; accessMode?: "direct" | "proxy" } = {},
): Promise<{ duplicate: boolean; image: ImageItem }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/images");
    request.withCredentials = true;
    request.setRequestHeader("x-csrf-token", csrfToken());
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      const body = JSON.parse(request.responseText || "{}") as {
        code?: string;
        duplicate?: boolean;
        image?: ImageItem;
      };
      if (request.status >= 200 && request.status < 300 && body.image) {
        resolve({ duplicate: body.duplicate ?? false, image: body.image });
      } else {
        reject(new ApiError(request.status, body.code ?? "UPLOAD_FAILED"));
      }
    });
    request.addEventListener("error", () => reject(new ApiError(0, "NETWORK_ERROR")));
    const form = new FormData();
    if (options.storageDriver) form.append("storage", options.storageDriver);
    if (options.accessMode) form.append("access", options.accessMode);
    form.append("file", file);
    request.send(form);
  });
}

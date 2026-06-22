import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { FastifyReply } from "fastify";
import type { AppConfig, StorageAccessMode, StorageDriver } from "./config.js";
import type { DataDirectories } from "./filesystem.js";

export type MediaAccessMode = StorageAccessMode;

export interface StoredMedia {
  storageDriver: StorageDriver;
  accessMode: MediaAccessMode;
  path: string;
  contentType?: string;
}

export interface StoreFileOptions extends StoredMedia {
  sourcePath: string;
  move?: boolean;
}

export interface MediaStorage {
  storeFile(options: StoreFileOptions): Promise<void>;
  materializeToLocal(media: StoredMedia, targetPath: string): Promise<void>;
  delete(media: StoredMedia): Promise<void>;
  publicUrl(media: StoredMedia): string;
  sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void>;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function pathInsideDirectory(directory: string, storedPath: string): string {
  if (isAbsolute(storedPath)) throw new Error("Stored media path must be relative");
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(resolvedDirectory, ...storedPath.split("/"));
  const difference = relative(resolvedDirectory, resolvedPath);
  if (difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Stored media path escapes the data directory");
  }
  return resolvedPath;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function contentTypeForPath(path: string): string {
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function validateStoredPath(storedPath: string): string {
  const normalizedPath = storedPath.split("\\").join("/");
  if (
    normalizedPath === "" ||
    normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    throw new Error("Stored media path escapes the storage prefix");
  }
  return normalizedPath;
}

function s3Key(config: AppConfig, storedPath: string): string {
  const normalizedPath = validateStoredPath(storedPath);
  return config.s3.prefix ? posix.join(config.s3.prefix, normalizedPath) : normalizedPath;
}

function s3PublicUrl(config: AppConfig, storedPath: string): string {
  const key = s3Key(config, storedPath);
  if (config.s3.publicBaseUrl) {
    return `${config.s3.publicBaseUrl}/${encodedPath(key)}`;
  }
  if (config.s3.endpoint) {
    const endpoint = config.s3.endpoint.replace(/\/$/, "");
    return config.s3.forcePathStyle
      ? `${endpoint}/${encodeURIComponent(config.s3.bucket)}/${encodedPath(key)}`
      : `${endpoint}/${encodedPath(key)}`;
  }
  return `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${encodedPath(key)}`;
}

export class LocalMediaStorage {
  readonly #directories: DataDirectories;

  constructor(directories: DataDirectories) {
    this.#directories = directories;
  }

  async storeFile(options: StoreFileOptions): Promise<void> {
    const targetPath = pathInsideDirectory(this.#directories.root, options.path);
    await mkdir(dirname(targetPath), { recursive: true });
    if (await pathExists(targetPath)) {
      if (options.move) await unlink(options.sourcePath).catch(() => undefined);
      return;
    }
    if (options.move) {
      try {
        await rename(options.sourcePath, targetPath);
      } catch (error) {
        if (await pathExists(targetPath)) {
          await unlink(options.sourcePath).catch(() => undefined);
          return;
        }
        throw error;
      }
    } else {
      await copyFile(options.sourcePath, targetPath);
    }
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    const sourcePath = pathInsideDirectory(this.#directories.root, media.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }

  async delete(media: StoredMedia): Promise<void> {
    await unlink(pathInsideDirectory(this.#directories.root, media.path)).catch(() => undefined);
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    const sourcePath = pathInsideDirectory(this.#directories.root, media.path);
    return reply
      .type(media.contentType ?? contentTypeForPath(media.path))
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("content-disposition", `inline; filename="${basename(media.path)}"`)
      .send(createReadStream(sourcePath));
  }
}

export class S3MediaStorage {
  readonly #config: AppConfig;
  readonly #client: S3Client;

  constructor(config: AppConfig, client?: S3Client) {
    this.#config = config;
    if (!config.s3.bucket) throw new Error("S3_BUCKET is required for S3 storage");
    const clientConfig: S3ClientConfig = {
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
    };
    if (config.s3.endpoint) clientConfig.endpoint = config.s3.endpoint;
    if (config.s3.accessKeyId && config.s3.secretAccessKey) {
      const credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      };
      if (config.s3.sessionToken) credentials.sessionToken = config.s3.sessionToken;
      clientConfig.credentials = credentials;
    }
    this.#client = client ?? new S3Client(clientConfig);
  }

  async storeFile(options: StoreFileOptions): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#config.s3.bucket,
        Key: s3Key(this.#config, options.path),
        Body: createReadStream(options.sourcePath),
        ContentType: options.contentType ?? contentTypeForPath(options.path),
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    if (options.move) await unlink(options.sourcePath).catch(() => undefined);
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true });
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#config.s3.bucket,
        Key: s3Key(this.#config, media.path),
      }),
    );
    if (!response.Body) throw new Error("S3 object response body is empty");
    await unlink(targetPath).catch(() => undefined);
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(targetPath, { flags: "wx" }));
  }

  async delete(media: StoredMedia): Promise<void> {
    await this.#client
      .send(
        new DeleteObjectCommand({
          Bucket: this.#config.s3.bucket,
          Key: s3Key(this.#config, media.path),
        }),
      )
      .catch(() => undefined);
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#config.s3.bucket,
        Key: s3Key(this.#config, media.path),
      }),
    );
    if (!response.Body) {
      reply.code(404).send({ status: "error", code: "MEDIA_NOT_FOUND" });
      return;
    }
    reply
      .type(response.ContentType ?? media.contentType ?? contentTypeForPath(media.path))
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("content-disposition", `inline; filename="${basename(media.path)}"`);
    if (response.ContentLength !== undefined) {
      reply.header("content-length", String(response.ContentLength));
    }
    return reply.send(response.Body);
  }
}

export class RoutedMediaStorage implements MediaStorage {
  readonly #config: AppConfig;
  readonly #local: LocalMediaStorage;
  #s3: S3MediaStorage | undefined;
  #s3Signature = "";

  constructor(config: AppConfig, directories: DataDirectories, s3?: S3MediaStorage) {
    this.#config = config;
    this.#local = new LocalMediaStorage(directories);
    if (s3) {
      this.#s3 = s3;
      this.#s3Signature = this.#currentS3Signature();
    } else if (config.s3.bucket) {
      this.#refreshS3();
    }
  }

  #currentS3Signature(): string {
    return JSON.stringify({
      endpoint: this.#config.s3.endpoint ?? "",
      region: this.#config.s3.region,
      bucket: this.#config.s3.bucket,
      prefix: this.#config.s3.prefix,
      forcePathStyle: this.#config.s3.forcePathStyle,
      accessKeyId: this.#config.s3.accessKeyId ?? "",
      secretAccessKey: this.#config.s3.secretAccessKey ?? "",
      sessionToken: this.#config.s3.sessionToken ?? "",
    });
  }

  #refreshS3(): S3MediaStorage {
    if (!this.#config.s3.bucket) throw new Error("S3 storage is not configured");
    const signature = this.#currentS3Signature();
    if (!this.#s3 || this.#s3Signature !== signature) {
      this.#s3 = new S3MediaStorage(this.#config);
      this.#s3Signature = signature;
    }
    return this.#s3;
  }

  #backend(driver: StorageDriver): LocalMediaStorage | S3MediaStorage {
    if (driver === "local") return this.#local;
    return this.#refreshS3();
  }

  async storeFile(options: StoreFileOptions): Promise<void> {
    return this.#backend(options.storageDriver).storeFile(options);
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    return this.#backend(media.storageDriver).materializeToLocal(media, targetPath);
  }

  async delete(media: StoredMedia): Promise<void> {
    return this.#backend(media.storageDriver).delete(media);
  }

  publicUrl(media: StoredMedia): string {
    if (media.storageDriver === "s3" && media.accessMode === "direct") {
      this.#refreshS3();
      return s3PublicUrl(this.#config, media.path);
    }
    if (media.storageDriver === "s3") {
      return `${this.#config.baseUrl}/media/proxy/${encodedPath(validateStoredPath(media.path))}`;
    }
    return `${this.#config.baseUrl}/media/${validateStoredPath(media.path)}`;
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    return this.#backend(media.storageDriver).sendProxy(media, reply);
  }
}

export function createMediaStorage(config: AppConfig, directories: DataDirectories): MediaStorage {
  return new RoutedMediaStorage(config, directories);
}

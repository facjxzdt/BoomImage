import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
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
  s3?: StoredS3Location | undefined;
}

export interface StoreFileOptions extends StoredMedia {
  sourcePath: string;
  move?: boolean;
}

export interface StoredS3Location {
  bucket: string;
  objectKey: string;
  endpoint?: string | undefined;
  region: string;
  publicBaseUrl?: string | undefined;
  forcePathStyle: boolean;
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
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown }).code === "ENOENT";
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

export function s3ObjectKey(config: AppConfig, storedPath: string): string {
  return s3ObjectKeyFromPrefix(config.s3.prefix, storedPath);
}

function s3ObjectKeyFromPrefix(prefix: string, storedPath: string): string {
  const normalizedPath = validateStoredPath(storedPath);
  return prefix ? posix.join(prefix, normalizedPath) : normalizedPath;
}

export function s3LocationFromConfig(s3: AppConfig["s3"], storedPath: string): StoredS3Location {
  if (!s3.bucket) throw new Error("S3 storage is not configured");
  return {
    bucket: s3.bucket,
    objectKey: s3ObjectKeyFromPrefix(s3.prefix, storedPath),
    endpoint: s3.endpoint,
    region: s3.region,
    publicBaseUrl: s3.publicBaseUrl,
    forcePathStyle: s3.forcePathStyle,
  };
}

export function currentS3Location(config: AppConfig, storedPath: string): StoredS3Location {
  return s3LocationFromConfig(config.s3, storedPath);
}

function s3Location(config: AppConfig, media: StoredMedia): StoredS3Location {
  return media.s3 ?? currentS3Location(config, media.path);
}

function s3PublicUrl(config: AppConfig, media: StoredMedia): string {
  const location = s3Location(config, media);
  if (location.publicBaseUrl) {
    return `${location.publicBaseUrl}/${encodedPath(location.objectKey)}`;
  }
  if (location.endpoint) {
    const endpoint = location.endpoint.replace(/\/$/, "");
    return location.forcePathStyle
      ? `${endpoint}/${encodeURIComponent(location.bucket)}/${encodedPath(location.objectKey)}`
      : `${endpoint}/${encodedPath(location.objectKey)}`;
  }
  return `https://${location.bucket}.s3.${location.region}.amazonaws.com/${encodedPath(location.objectKey)}`;
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
    try {
      await unlink(pathInsideDirectory(this.#directories.root, media.path));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
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
  #client: S3Client;
  #clientSignature = "";

  constructor(config: AppConfig, client?: S3Client) {
    this.#config = config;
    const defaultLocation: StoredS3Location = {
      bucket: config.s3.bucket,
      objectKey: "healthcheck",
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      publicBaseUrl: config.s3.publicBaseUrl,
      forcePathStyle: config.s3.forcePathStyle,
    };
    this.#client = client ?? this.#createClient(defaultLocation);
    this.#clientSignature = this.#signature(defaultLocation);
  }

  #createClient(location: StoredS3Location): S3Client {
    const clientConfig: S3ClientConfig = {
      region: location.region,
      forcePathStyle: location.forcePathStyle,
    };
    if (location.endpoint) clientConfig.endpoint = location.endpoint;
    if (this.#config.s3.accessKeyId && this.#config.s3.secretAccessKey) {
      const credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = {
        accessKeyId: this.#config.s3.accessKeyId,
        secretAccessKey: this.#config.s3.secretAccessKey,
      };
      if (this.#config.s3.sessionToken) credentials.sessionToken = this.#config.s3.sessionToken;
      clientConfig.credentials = credentials;
    }
    return new S3Client(clientConfig);
  }

  #signature(location: StoredS3Location): string {
    return JSON.stringify({
      endpoint: location.endpoint ?? "",
      region: location.region,
      forcePathStyle: location.forcePathStyle,
      accessKeyId: this.#config.s3.accessKeyId ?? "",
      secretAccessKey: this.#config.s3.secretAccessKey ?? "",
      sessionToken: this.#config.s3.sessionToken ?? "",
    });
  }

  #clientFor(location: StoredS3Location): S3Client {
    const signature = this.#signature(location);
    if (this.#clientSignature !== signature) {
      this.#client = this.#createClient(location);
      this.#clientSignature = signature;
    }
    return this.#client;
  }

  async storeFile(options: StoreFileOptions): Promise<void> {
    const location = options.s3 ?? currentS3Location(this.#config, options.path);
    await this.#clientFor(location).send(
      new PutObjectCommand({
        Bucket: location.bucket,
        Key: location.objectKey,
        Body: createReadStream(options.sourcePath),
        ContentType: options.contentType ?? contentTypeForPath(options.path),
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    if (options.move) await unlink(options.sourcePath).catch(() => undefined);
  }

  async materializeToLocal(media: StoredMedia, targetPath: string): Promise<void> {
    const location = s3Location(this.#config, media);
    await mkdir(dirname(targetPath), { recursive: true });
    const response = await this.#clientFor(location).send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.objectKey,
      }),
    );
    if (!response.Body) throw new Error("S3 object response body is empty");
    await unlink(targetPath).catch(() => undefined);
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(targetPath, { flags: "wx" }));
  }

  async delete(media: StoredMedia): Promise<void> {
    const location = s3Location(this.#config, media);
    await this.#clientFor(location).send(
      new DeleteObjectCommand({
        Bucket: location.bucket,
        Key: location.objectKey,
      }),
    );
  }

  async sendProxy(media: StoredMedia, reply: FastifyReply): Promise<void> {
    const location = s3Location(this.#config, media);
    const response = await this.#clientFor(location).send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.objectKey,
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
      return s3PublicUrl(this.#config, media);
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

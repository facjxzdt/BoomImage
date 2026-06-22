import { access, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface DataDirectories {
  root: string;
  temporary: string;
  originals: string;
  variants: string;
}

export async function prepareDataDirectories(root: string): Promise<DataDirectories> {
  const directories: DataDirectories = {
    root,
    temporary: join(root, "tmp"),
    originals: join(root, "originals"),
    variants: join(root, "variants"),
  };

  await Promise.all(
    Object.values(directories).map((directory) => mkdir(directory, { recursive: true })),
  );

  return directories;
}

export async function assertDirectoryWritable(directory: string): Promise<void> {
  await access(directory, constants.R_OK | constants.W_OK);

  const probePath = join(directory, `.write-probe-${process.pid}-${Date.now()}`);
  const probe = await open(probePath, "wx");
  await probe.close();
  await unlink(probePath);
}

export interface TemporaryCleanupOptions {
  olderThanMs: number;
  now?: Date;
}

export interface TemporaryCleanupResult {
  scanned: number;
  deleted: number;
  skipped: number;
  errors: number;
}

function pathInsideDirectory(directory: string, candidate: string): string {
  const resolvedDirectory = resolve(directory);
  const resolvedCandidate = resolve(candidate);
  const difference = relative(resolvedDirectory, resolvedCandidate);
  if (difference === "" || difference.startsWith("..") || isAbsolute(difference)) {
    throw new Error("Temporary cleanup path escapes the temporary directory");
  }
  return resolvedCandidate;
}

export async function cleanupTemporaryFiles(
  temporaryDirectory: string,
  options: TemporaryCleanupOptions,
): Promise<TemporaryCleanupResult> {
  const result: TemporaryCleanupResult = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
  };
  const cutoff = (options.now ?? new Date()).getTime() - options.olderThanMs;
  const resolvedDirectory = resolve(temporaryDirectory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });

  for (const entry of entries) {
    result.scanned += 1;

    if (!entry.isFile()) {
      result.skipped += 1;
      continue;
    }

    try {
      const path = pathInsideDirectory(resolvedDirectory, join(resolvedDirectory, entry.name));
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.mtimeMs > cutoff) {
        result.skipped += 1;
        continue;
      }

      await unlink(path);
      result.deleted += 1;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        result.skipped += 1;
      } else {
        result.errors += 1;
      }
    }
  }

  return result;
}

import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTemporaryFiles } from "../src/filesystem.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boomimage-fs-test-"));
  cleanupDirectories.push(directory);
  return directory;
}

describe("temporary file cleanup", () => {
  it("deletes only expired regular files in the temporary directory", async () => {
    const directory = await temporaryDirectory();
    const now = new Date("2026-06-22T00:00:00.000Z");
    const expiredFile = join(directory, "expired.upload");
    const freshFile = join(directory, "fresh.upload");
    const nestedDirectory = join(directory, "nested");
    const nestedFile = join(nestedDirectory, "expired.upload");

    await writeFile(expiredFile, "old");
    await writeFile(freshFile, "fresh");
    await mkdir(nestedDirectory);
    await writeFile(nestedFile, "nested");
    await utimes(expiredFile, new Date(now.getTime() - 7_200_000), new Date(now.getTime() - 7_200_000));
    await utimes(freshFile, now, now);
    await utimes(nestedFile, new Date(now.getTime() - 7_200_000), new Date(now.getTime() - 7_200_000));

    const result = await cleanupTemporaryFiles(directory, {
      olderThanMs: 3_600_000,
      now,
    });

    await expect(access(expiredFile)).rejects.toThrow();
    await expect(readFile(freshFile, "utf8")).resolves.toBe("fresh");
    await expect(readFile(nestedFile, "utf8")).resolves.toBe("nested");
    expect(result).toEqual({
      scanned: 3,
      deleted: 1,
      skipped: 2,
      errors: 0,
    });
  });
});

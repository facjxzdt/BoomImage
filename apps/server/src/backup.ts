import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./database.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function assertDestinationOutsideData(dataDir: string, destination: string): void {
  const difference = relative(resolve(dataDir), resolve(destination));
  if (difference === "" || (!difference.startsWith("..") && !isAbsolute(difference))) {
    throw new Error("Backup destination must be outside APP_DATA_DIR");
  }
}

export async function createBackup(config: AppConfig, destinationRoot: string): Promise<string> {
  const resolvedDestinationRoot = resolve(destinationRoot);
  const backupDirectory = resolve(resolvedDestinationRoot, `boomimage-${timestamp()}`);
  assertDestinationOutsideData(config.dataDir, backupDirectory);
  await mkdir(resolvedDestinationRoot, { recursive: true });
  await mkdir(backupDirectory, { recursive: false });

  const database = await openDatabase(config.databasePath, config.migrationsDir);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const snapshotSource = new DatabaseSync(config.databasePath, { readOnly: true });
      try {
        await backup(snapshotSource, join(backupDirectory, "boomimage.db"));
      } finally {
        snapshotSource.close();
      }
      await Promise.all([
        cp(join(config.dataDir, "originals"), join(backupDirectory, "originals"), {
          recursive: true,
          force: false,
        }),
        cp(join(config.dataDir, "variants"), join(backupDirectory, "variants"), {
          recursive: true,
          force: false,
        }),
      ]);
      await writeFile(
        join(backupDirectory, "manifest.json"),
        `${JSON.stringify(
          {
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            application: "BoomImage",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    database.close();
  }

  return backupDirectory;
}

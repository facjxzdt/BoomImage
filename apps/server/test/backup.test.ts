import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { prepareDataDirectories } from "../src/filesystem.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("backup", () => {
  it("creates a consistent database snapshot with media and a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "boomimage-backup-test-"));
    cleanupDirectories.push(root);
    const dataDir = join(root, "data");
    const config = loadConfig({
      APP_DATA_DIR: dataDir,
      MIGRATIONS_DIR: resolve(process.cwd(), "../../migrations"),
      LOG_LEVEL: "silent",
    });
    const directories = await prepareDataDirectories(dataDir);
    const database = await openDatabase(config.databasePath, config.migrationsDir);
    database
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("backup-test", "present", new Date().toISOString());
    database.close();
    await writeFile(join(directories.originals, "sample.bin"), "original-media");
    await writeFile(join(directories.variants, "sample.bin"), "variant-media");

    const backupDirectory = await createBackup(config, join(root, "backups"));
    expect((await stat(join(backupDirectory, "boomimage.db"))).size).toBeGreaterThan(0);
    expect(await readFile(join(backupDirectory, "originals", "sample.bin"), "utf8")).toBe("original-media");
    expect(await readFile(join(backupDirectory, "variants", "sample.bin"), "utf8")).toBe("variant-media");
    expect(JSON.parse(await readFile(join(backupDirectory, "manifest.json"), "utf8"))).toMatchObject({
      formatVersion: 1,
      application: "BoomImage",
    });

    const snapshot = new DatabaseSync(join(backupDirectory, "boomimage.db"), { readOnly: true });
    const setting = snapshot.prepare("SELECT value FROM app_settings WHERE key = 'backup-test'").get();
    expect(setting?.value).toBe("present");
    snapshot.close();
  });
});


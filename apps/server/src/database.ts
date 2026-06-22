import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATION_FILE_PATTERN = /^(\d+)[-_].+\.sql$/;

export type AppDatabase = DatabaseSync;

export function immediateTransaction<T>(database: AppDatabase, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

interface MigrationFile {
  version: number;
  filename: string;
}

async function listMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match?.[1]) continue;
    migrations.push({ version: Number(match[1]), filename: entry.name });
  }

  migrations.sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index]?.version === migrations[index - 1]?.version) {
      throw new Error(`Duplicate database migration version: ${migrations[index]?.version}`);
    }
  }

  return migrations;
}

export async function migrateDatabase(
  database: AppDatabase,
  migrationsDirectory: string,
): Promise<void> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database.prepare("SELECT version FROM schema_migrations").all();
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const migration of await listMigrations(migrationsDirectory)) {
    if (applied.has(migration.version)) continue;

    const sql = await readFile(join(migrationsDirectory, migration.filename), "utf8");
    immediateTransaction(database, () => {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.filename, new Date().toISOString());
    });
  }
}

export async function openDatabase(
  databasePath: string,
  migrationsDirectory: string,
): Promise<AppDatabase> {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    await migrateDatabase(database, migrationsDirectory);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function assertDatabaseReady(database: AppDatabase): void {
  const result = database.prepare("SELECT 1 AS value").get();
  if (Number(result?.value) !== 1) throw new Error("Database readiness query failed");
}

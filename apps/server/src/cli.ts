import { resolve } from "node:path";
import { createBackup } from "./backup.js";
import { loadConfig } from "./config.js";

const [, , command, ...rawArguments] = process.argv;
const [destinationArgument] = rawArguments.filter((argument) => argument !== "--");

if (command !== "backup") {
  console.error("Usage: pnpm backup -- [destination-directory]");
  process.exitCode = 1;
} else {
  try {
    const destination = resolve(destinationArgument ?? "./backups");
    const backupDirectory = await createBackup(loadConfig(), destination);
    console.log(`Backup created: ${backupDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

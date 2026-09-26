import { bootstrapDatabase, APP_VERSION } from "../db/bootstrap.js";
import { openDatabase } from "../db/client.js";
import { loadConfig } from "../config.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";

const config = loadConfig();
const handle = openDatabase(config.dbPath, config.sqliteSynchronous, { runtime: true });
bootstrapDatabase(handle);
console.log(
  `[contextkeep] migrations applied — schema v${SERVER_SCHEMA_VERSION}, app v${APP_VERSION}, store: ${config.dbPath}`,
);
handle.sqlite.close();

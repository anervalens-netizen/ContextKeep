import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SchemaVersionError } from "./db/bootstrap.js";
import { initTelemetry } from "./lib/telemetry.js";
import { seedDemo } from "./seed.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.secretIsEphemeral) {
    console.warn(
      "[contextkeep] CK_SESSION_SECRET is not set — using an ephemeral secret. " +
        "Sessions and password hashing pepper will not survive restarts. Set CK_SESSION_SECRET in .env.",
    );
  }

  let app;
  try {
    app = await buildApp({ config });
  } catch (e) {
    if (e instanceof SchemaVersionError) {
      console.error(`[contextkeep] ${e.message}`);
      process.exit(2); // A17: refuse to start on a newer-version store
    }
    throw e;
  }

  if (config.seedOnStart) {
    const result = seedDemo(app.ck.deps, { actor: "system:seed" });
    console.log(`[contextkeep] seed: ${result.seeded ? "demo data created" : "skipped (store not empty)"}`);
  }

  const shutdownTelemetry = await initTelemetry(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`[contextkeep] ${signal} received — shutting down`);
    try {
      await app.close();
      await shutdownTelemetry();
      process.exit(0);
    } catch (e) {
      app.log.error({ err: e }, "shutdown error");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => {
  console.error("[contextkeep] fatal startup error:", e);
  process.exit(1);
});

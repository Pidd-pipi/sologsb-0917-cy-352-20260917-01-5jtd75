import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./common/logger";
import { connectDatabase } from "./config/db";

async function start(): Promise<void> {
  await connectDatabase();
  app.listen(env.port, "0.0.0.0", () => {
    logger.info(`API listening on port ${env.port}`);
  });
}

start().catch((error) => {
  logger.error(`Failed to start service: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

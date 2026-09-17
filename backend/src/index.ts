import { app } from "./app";
import { connectDatabase } from "./config/database";
import { env } from "./config/env";
import { logger } from "./common/logger";

async function start() {
  try {
    await connectDatabase();
  } catch (error) {
    logger.error(
      `MongoDB 连接失败：${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }

  app.listen(env.port, "0.0.0.0", () => {
    logger.info(`API listening on port ${env.port}`);
  });
}

start();

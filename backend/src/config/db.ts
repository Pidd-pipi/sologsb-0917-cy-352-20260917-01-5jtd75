import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "../common/logger";
import { ensureIndexes } from "../modules/matches/match.model";
import { reconcileAllStats } from "../modules/matches/stats.service";

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }
  if (connecting) {
    return connecting;
  }

  connecting = mongoose
    .connect(env.databaseUrl, {
      appName: "lpboardgame-backend",
      serverSelectionTimeoutMS: 10_000,
      // 路由等短暂中断后自动重连
      autoIndex: true,
    })
    .then((m) => m);

  try {
    await connecting;
  } catch (error) {
    connecting = null;
    throw error;
  }

  mongoose.connection.on("error", (error) => {
    logger.error(`MongoDB connection error: ${String(error)}`);
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("MongoDB disconnected");
  });

  await ensureIndexes();
  // 启动自愈：即使上次写入在中途崩溃，流水也会按源记录重建为一致状态
  await reconcileAllStats();

  logger.info(`MongoDB connected (db=${env.dbName})`);
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  connecting = null;
}

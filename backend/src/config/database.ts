import mongoose from "mongoose";
import { env, resolveDatabaseUrl } from "../config/env";
import { logger } from "../common/logger";

let connecting: Promise<typeof mongoose> | null = null;

/**
 * 连接 MongoDB。多个请求同时触发首连时共用同一个 Promise。
 * 战绩写入依赖多文档事务，连接串必须指向副本集。
 */
export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (mongoose.connection.readyState === 2 && connecting) {
    return connecting;
  }

  connecting = mongoose
    .connect(resolveDatabaseUrl(), {
      appName: "lpboardgame",
      serverSelectionTimeoutMS: 5000,
      // 事务内读写均使用 majority 关注级别，保证回滚/提交的可见性一致。
      readPreference: "primary",
      ignoreUndefined: true,
    })
    .then((connection) => {
      logger.info(`MongoDB connected: ${env.dbName}`);
      return connection;
    })
    .catch((error) => {
      connecting = null;
      throw error;
    });

  return connecting;
}

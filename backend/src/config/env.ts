export const env = {
  port: Number(process.env.PORT ?? 29512),
  dbHost: process.env.DB_HOST ?? "127.0.0.1",
  dbPort: Number(process.env.DB_PORT ?? 27017),
  dbName: process.env.DB_NAME ?? "app",
  dbUser: process.env.DB_USER ?? "",
  dbPassword: process.env.DB_PASSWORD ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "change_me",
};

export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL?.trim()) {
    return process.env.DATABASE_URL.trim();
  }

  const credentials = env.dbUser
    ? `${encodeURIComponent(env.dbUser)}:${encodeURIComponent(env.dbPassword)}@`
    : "";
  // 战绩写入使用 MongoDB 多文档事务，要求连接指向副本集（本地为 rs0）。
  return `mongodb://${credentials}${env.dbHost}:${env.dbPort}/${env.dbName}?replicaSet=rs0&serverSelectionTimeoutMS=5000`;
}

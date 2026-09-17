export const env = {
  port: Number(process.env.PORT ?? 29512),
  dbHost: process.env.DB_HOST ?? "localhost",
  dbPort: Number(process.env.DB_PORT ?? 27017),
  dbName: process.env.DB_NAME ?? "app",
  dbUser: process.env.DB_USER ?? "app",
  dbPassword: process.env.DB_PASSWORD ?? "app_pwd",
  /** 优先使用完整连接串（docker-compose 注入 DATABASE_URL），否则按字段拼装 */
  databaseUrl:
    process.env.DATABASE_URL ??
    `mongodb://${process.env.DB_USER ?? "app"}:${process.env.DB_PASSWORD ?? "app_pwd"}@${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? 27017}/${process.env.DB_NAME ?? "app"}?authSource=admin`,
  jwtSecret: process.env.JWT_SECRET ?? "change_me",
};

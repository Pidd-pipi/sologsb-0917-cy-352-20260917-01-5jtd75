import cors from "cors";
import express from "express";
import helmet from "helmet";
import { overviewRouter } from "./modules/overview/overview.routes";
import { matchRouter } from "./modules/matches/match.routes";
import { matchErrorHandler } from "./modules/matches/match.controller";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));

// 战绩与排行榜闭环接口：
// 同时挂在根路径和 /api 下，与 nginx（/api/ -> 后端 /）、vite dev proxy 的路径改写保持一致
app.use("/", matchRouter);
app.use("/api", matchRouter);

app.use("/", overviewRouter);
app.use("/api", overviewRouter);

app.use(matchErrorHandler);

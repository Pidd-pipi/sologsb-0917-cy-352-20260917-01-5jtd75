import { Router } from "express";
import {
  correctMatch,
  createMatch,
  getLeaderboard,
  listMatches,
} from "./match.controller";

export const matchRouter = Router();

// 战绩与排行榜
matchRouter.post("/matches", createMatch);
matchRouter.get("/matches", listMatches);
matchRouter.put("/matches/:id", correctMatch);
matchRouter.get("/leaderboard", getLeaderboard);

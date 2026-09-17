import { Router } from "express";
import {
  createMatch,
  getLeaderboard,
  getMatch,
  listMatches,
  updateMatch,
} from "./record.controller";
import { asyncHandler } from "./record.middleware";

export const recordsRouter = Router();

recordsRouter.get("/matches", asyncHandler(listMatches));
recordsRouter.post("/matches", asyncHandler(createMatch));
recordsRouter.get("/matches/:matchId", asyncHandler(getMatch));
recordsRouter.put("/matches/:matchId", asyncHandler(updateMatch));
recordsRouter.get("/leaderboard", asyncHandler(getLeaderboard));

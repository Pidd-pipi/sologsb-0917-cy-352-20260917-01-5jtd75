import type { Request, Response } from "express";
import { RecordService } from "./record.service";

const service = new RecordService();

export async function listMatches(_request: Request, response: Response) {
  const matches = await service.listMatches();
  response.json({ matches });
}

export async function getMatch(request: Request, response: Response) {
  const matchId = String(request.params.matchId);
  const match = await service.getMatch(matchId);
  response.json({ match });
}

export async function createMatch(request: Request, response: Response) {
  const match = await service.createMatch(request.body ?? {});
  response.status(201).json({ match });
}

export async function updateMatch(request: Request, response: Response) {
  const matchId = String(request.params.matchId);
  const match = await service.updateMatch(matchId, request.body ?? {});
  response.json({ match });
}

export async function getLeaderboard(_request: Request, response: Response) {
  const leaderboard = await service.getLeaderboard();
  response.json({ leaderboard });
}

import type { ObjectId } from "mongoose";

export type MatchStatus = "finished" | "ongoing";

export interface MatchInput {
  matchId?: string;
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt?: string;
  note?: string;
  status: MatchStatus;
}

export interface MatchDoc {
  _id: ObjectId;
  matchId: string;
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt: Date;
  note: string;
  status: MatchStatus;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlayerStatsDoc {
  _id: ObjectId;
  playerName: string;
  matchesCount: number;
  winsCount: number;
  updatedAt: Date;
}

export interface LeaderboardEntry {
  playerName: string;
  matchesCount: number;
  winsCount: number;
  lossesCount: number;
  winRate: number;
  rank: number;
}

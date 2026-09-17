export interface FeatureItem {
  id: number;
  title: string;
  description: string;
  status: string;
  metric: string;
}

export interface KpiItem {
  label: string;
  value: string;
  trend: string;
  tone: string;
}

export interface OperationRecord {
  key: string;
  name: string;
  owner: string;
  status: string;
  metric: string;
  priority: string;
}

export interface OverviewResponse {
  appName: string;
  appCode: string;
  description: string;
  features: FeatureItem[];
  kpis: KpiItem[];
  records: OperationRecord[];
}

export type MatchStatus = "finished" | "ongoing";

export interface MatchRecord {
  matchId: string;
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt: string;
  note: string;
  status: MatchStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MatchFormPayload {
  matchId?: string;
  boardGame: string;
  participantNames: string[];
  winnerNames: string[];
  durationMinutes: number;
  playedAt?: string;
  note?: string;
  status: MatchStatus;
}

export interface LeaderboardEntry {
  playerName: string;
  matchesCount: number;
  winsCount: number;
  lossesCount: number;
  winRate: number;
  rank: number;
}


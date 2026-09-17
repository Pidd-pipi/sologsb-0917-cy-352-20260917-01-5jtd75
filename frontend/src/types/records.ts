export interface MatchView {
  id: string;
  clientRequestId: string;
  game: { name: string; category: string };
  participants: string[];
  winners: string[];
  durationMinutes: number;
  playedAt: string;
  note: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MatchFormValues {
  gameName: string;
  category: string;
  participants: string[];
  winners: string[];
  durationMinutes: number;
  playedAt: string;
  note: string;
}

export interface LeaderboardRow {
  rank: number;
  player: string;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  totalMinutes: number;
  games: string[];
}

export interface LeaderboardResponse {
  totalMatches: number;
  rows: LeaderboardRow[];
}

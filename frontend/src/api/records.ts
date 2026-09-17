import { API_BASE_URL } from "../constants/app";
import type { LeaderboardEntry, MatchFormPayload, MatchRecord } from "../types";

async function parseError(response: Response): Promise<Error> {
  let message = `请求失败（${response.status}）`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) {
      message = body.message;
    }
  } catch {
    // 忽略非 JSON 错误体
  }
  const error = new Error(message) as Error & { status?: number };
  error.status = response.status;
  return error;
}

export async function fetchMatches(): Promise<MatchRecord[]> {
  const response = await fetch(`${API_BASE_URL}/records/matches`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { matches: MatchRecord[] };
  return body.matches;
}

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  const response = await fetch(`${API_BASE_URL}/records/leaderboard`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { leaderboard: LeaderboardEntry[] };
  return body.leaderboard;
}

export async function submitMatch(payload: MatchFormPayload): Promise<MatchRecord> {
  // 指定 matchId 为修正，未指定为新建。
  const hasMatchId = Boolean(payload.matchId);
  const url = hasMatchId
    ? `${API_BASE_URL}/records/matches/${encodeURIComponent(payload.matchId as string)}`
    : `${API_BASE_URL}/records/matches`;

  const response = await fetch(url, {
    method: hasMatchId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  const body = (await response.json()) as { match: MatchRecord };
  return body.match;
}

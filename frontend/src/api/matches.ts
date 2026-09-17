import { API_BASE_URL } from "../constants/app";
import type {
  LeaderboardResponse,
  MatchFormValues,
  MatchView,
} from "../types/records";

/** 生成幂等键：优先 UUID，老浏览器退化为随机串 */
function newRequestId(): string {
  const cryptoLike = globalThis.crypto as Crypto | undefined;
  if (cryptoLike && typeof cryptoLike.randomUUID === "function") {
    return cryptoLike.randomUUID();
  }
  return `rid-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await parseJson(response)) as {
    data?: T;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(json.message ?? `请求失败：${response.status}`);
  }
  return json.data as T;
}

/** 录入对局：X-Request-Id 保证并发/重试重复提交不重复计分 */
export async function createMatch(
  values: MatchFormValues,
): Promise<MatchView> {
  return request<MatchView>("POST", "/matches", values, {
    "X-Request-Id": newRequestId(),
  });
}

/** 修正对局：expectedRevision 为乐观锁版本，并发修正只有一个能成功 */
export async function correctMatch(
  id: string,
  values: MatchFormValues,
  expectedRevision: number,
): Promise<{ data: MatchView; rolledBack: number }> {
  const response = await fetch(`${API_BASE_URL}/matches/${id}`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ ...values, expectedRevision }),
  });
  const json = (await parseJson(response)) as {
    data?: MatchView;
    rolledBack?: number;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(json.message ?? `请求失败：${response.status}`);
  }
  return { data: json.data as MatchView, rolledBack: json.rolledBack ?? 0 };
}

export async function fetchMatches(): Promise<MatchView[]> {
  return request<MatchView[]>("GET", "/matches");
}

export async function fetchLeaderboard(): Promise<LeaderboardResponse> {
  const response = await fetch(`${API_BASE_URL}/leaderboard`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`排行榜请求失败：${response.status}`);
  }
  return response.json() as Promise<LeaderboardResponse>;
}

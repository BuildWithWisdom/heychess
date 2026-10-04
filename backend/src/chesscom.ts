import { Chess } from "chess.js";
import type { Game } from "@heychess/contracts";

const UA = "HeyChess/0.1 (contact: aguowisdom; dev MVP)";

type ChessComGame = {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  time_class: string;
  rules: string;
  accuracies?: { white?: number; black?: number };
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
};

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`chess.com ${res.status} for ${url}`);
  return res.json();
}

function mapResult(game: ChessComGame, username: string): Game["result"] {
  const lower = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === lower;
  const mine = isWhite ? game.white.result : game.black.result;
  const theirs = isWhite ? game.black.result : game.white.result;
  if (mine === "win") return "win";
  if (theirs === "win") return "loss";
  return "draw";
}

function formatTimeControl(game: ChessComGame): string {
  const tc = game.time_class ?? "";
  return tc ? tc[0].toUpperCase() + tc.slice(1) : game.time_control;
}

function toGame(game: ChessComGame, username: string): Game | null {
  try {
    // Validate PGN parses — skip broken variants (bughouse, etc.)
    new Chess().loadPgn(game.pgn);
  } catch {
    return null;
  }
  const lower = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === lower;
  const opponent =
    game.white.username.toLowerCase() === lower ? game.black.username : game.white.username;
  // Chess.com only sends accuracies if the game was Game-Reviewed.
  // Pass through the user's side so the list has instant values.
  const rawAcc = isWhite ? game.accuracies?.white : game.accuracies?.black;
  return {
    id: game.url,
    opponent,
    result: mapResult(game, username),
    timeControl: formatTimeControl(game),
    ...(rawAcc !== undefined && Number.isFinite(rawAcc)
      ? { accuracy: Math.round(rawAcc) }
      : {}),
    date: new Date(game.end_time * 1000).toISOString(),
    source: "chesscom",
    pgn: game.pgn,
  };
}

export async function getChessComStats(username: string): Promise<{
  username: string;
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}> {
  const data = (await fetchJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`
  )) as Record<string, { record?: { win?: number; loss?: number; draw?: number } }>;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const v of Object.values(data)) {
    const r = v?.record;
    if (!r) continue;
    wins += Number(r.win ?? 0) || 0;
    losses += Number(r.loss ?? 0) || 0;
    draws += Number(r.draw ?? 0) || 0;
  }
  const totalGames = wins + losses + draws;
  const winRate = totalGames === 0 ? 0 : Math.round((wins / totalGames) * 100);
  return { username, totalGames, wins, losses, draws, winRate };
}

export type ChessComGameMeta = {
  whiteAcc?: number;
  blackAcc?: number;
  timeClass?: string;
};

// Same fetch as getChessComGames but keeps raw accuracies for DB storage.
// Keyed by game URL (= Game.id).
export async function getChessComGamesWithMeta(
  username: string,
  limit = 20
): Promise<{ games: Game[]; meta: Map<string, ChessComGameMeta> }> {
  const archivesData = (await fetchJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`
  )) as { archives: string[] };

  // Last 3 months only for MVP speed. Oldest -> newest, so take tail.
  const archives = archivesData.archives.slice(-3);
  const settled = await Promise.allSettled(archives.map((url) => fetchJson(url)));
  const raw: ChessComGame[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") raw.push(...(s.value.games as ChessComGame[]));
  }
  raw.sort((a, b) => b.end_time - a.end_time);
  const games: Game[] = [];
  const meta = new Map<string, ChessComGameMeta>();
  for (const g of raw) {
    if (games.length >= Math.min(limit, 50)) break;
    const mapped = toGame(g, username);
    if (mapped) {
      games.push(mapped);
      meta.set(g.url, {
        whiteAcc: g.accuracies?.white,
        blackAcc: g.accuracies?.black,
        timeClass: g.time_class,
      });
    }
  }
  return { games, meta };
}

export async function getChessComGames(username: string, limit = 20): Promise<Game[]> {
  const { games } = await getChessComGamesWithMeta(username, limit);
  return games;
}

// FULL sync: every archive (all-time), newest first. Used by the background
// sync so "All" is truly all games, not the last-3-months window.
// Archives are fetched 3-at-a-time to stay friendly to chess.com rate limits.
export async function fetchAllChessComGames(
  username: string
): Promise<{ games: Game[]; meta: Map<string, ChessComGameMeta> }> {
  const archivesData = (await fetchJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`
  )) as { archives: string[] };

  const queue = [...archivesData.archives];
  const raw: ChessComGame[] = [];
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      try {
        const data = await fetchJson(url);
        raw.push(...(data.games as ChessComGame[]));
      } catch (e) {
        console.error(`[fetchAll] archive failed ${url}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, () => worker()));

  raw.sort((a, b) => b.end_time - a.end_time);
  const games: Game[] = [];
  const meta = new Map<string, ChessComGameMeta>();
  for (const g of raw) {
    const mapped = toGame(g, username);
    if (mapped) {
      games.push(mapped);
      meta.set(g.url, {
        whiteAcc: g.accuracies?.white,
        blackAcc: g.accuracies?.black,
        timeClass: g.time_class,
      });
    }
  }
  return { games, meta };
}

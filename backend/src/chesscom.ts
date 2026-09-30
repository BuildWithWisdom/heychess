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
  const opponent =
    game.white.username.toLowerCase() === lower ? game.black.username : game.white.username;
  return {
    id: game.url,
    opponent,
    result: mapResult(game, username),
    timeControl: formatTimeControl(game),
    date: new Date(game.end_time * 1000).toISOString(),
    source: "chesscom",
    pgn: game.pgn,
  };
}

export async function getChessComGames(username: string, limit = 20): Promise<Game[]> {
  const archivesData = (await fetchJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`
  )) as { archives: string[] };

  // Last 3 months only for MVP speed. Oldest -> newest, so take tail.
  const archives = archivesData.archives.slice(-3);
  const settled = await Promise.allSettled(archives.map((url) => fetchJson(url)));
  const games: ChessComGame[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") games.push(...(s.value.games as ChessComGame[]));
  }
  games.sort((a, b) => b.end_time - a.end_time);
  const out: Game[] = [];
  for (const g of games) {
    if (out.length >= Math.min(limit, 50)) break;
    const mapped = toGame(g, username);
    if (mapped) out.push(mapped);
  }
  return out;
}

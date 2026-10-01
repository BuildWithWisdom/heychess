import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chess } from "chess.js";
import { GameAnalysisSchema, GameDetailSchema, GameSchema } from "@heychess/contracts";
import { getChessComGames } from "./chesscom.ts";
import { analyzePgn } from "./engine.ts";
import { explainGame } from "./llm.ts";
import { identifyOpening } from "./openings.ts";

const app = new Hono();

app.use("/*", cors({ origin: ["http://localhost:5173"], credentials: true }));

app.get("/healthz", (c) => c.json({ ok: true, service: "heychess-backend" }));

// Parse [%clk 0:09:58.2] / [0:03:42] / [92.5] -> seconds remaining.
function parseClkToSecs(raw: string): number | null {
  const s = raw.trim();
  if (/^[\d.]+$/.test(s)) {
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }
  const parts = s.split(":").map((p) => p.trim());
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let total = 0;
  for (const n of nums) total = total * 60 + n;
  return total;
}

// Clocks appear in move order in the PGN movetext: 1. e4 {[%clk 0:10:00]} ...
function extractClocks(pgn: string): number[] {
  const out: number[] = [];
  const re = /\[%clk\s+([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    const v = parseClkToSecs(m[1]);
    if (v !== null) out.push(v);
  }
  return out;
}

// [TimeControl "600+5"] -> { base: 600, inc: 5 }. Handles "600", "180+2", "-".
function parseTimeControl(pgn: string): { base: number | null; inc: number } {
  const m = pgn.match(/\[TimeControl\s+"([^"]+)"\]/);
  if (!m) return { base: null, inc: 0 };
  const tc = m[1].trim();
  if (tc === "-" || tc === "") return { base: null, inc: 0 };
  const plus = tc.split("+");
  const base = Number(plus[0]);
  const inc = plus.length > 1 ? Number(plus[1]) : 0;
  return {
    base: Number.isFinite(base) ? base : null,
    inc: Number.isFinite(inc) ? inc : 0,
  };
}
// Slice 1a: live Chess.com proxy, in-memory, no DB.
app.get("/api/games", async (c) => {
  const username = (c.req.query("username") ?? "").trim();
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
  if (!username) return c.json({ error: "username required" }, 400);

  try {
    const games = (await getChessComGames(username, limit)).map((g) =>
      GameSchema.parse(g)
    );
    return c.json({ username, games });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    if (msg.includes("404")) return c.json({ error: "chess.com user not found" }, 404);
    return c.json({ error: msg }, 502);
  }
});

// Slice 1c: parse PGN into board-ready moves. Stateless, no DB.
app.post("/api/games/parse", async (c) => {
  const body = await c.req.json().catch(() => null);
  const pgn = typeof body?.pgn === "string" ? body.pgn : "";
  if (!pgn) return c.json({ error: "pgn required" }, 400);
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const initialFen = new Chess().fen();
    const verbose = chess.history({ verbose: true });
    const replay = new Chess();
    const clocks = extractClocks(pgn);
    const { base, inc } = parseTimeControl(pgn);
    const moves = verbose.map((m, i) => {
      replay.move(m.san);
      return {
        ply: i + 1,
        moveNo: Math.floor(i / 2) + 1,
        color: i % 2 === 0 ? "w" : "b",
        san: m.san,
        fen: replay.fen(),
        // Only attach when the PGN actually carried a clock for this ply.
        ...(i < clocks.length ? { clockSecs: clocks[i] } : {}),
      };
    });
    const opening = identifyOpening(verbose.map((m) => m.san));
    return c.json(GameDetailSchema.parse({
      initialFen,
      moves,
      opening,
      incrementSecs: inc,
      ...(base !== null ? { baseSecs: base } : {}),
    }));
  } catch {
    return c.json({ error: "invalid pgn" }, 400);
  }
});

// Slice 1d: server Stockfish analysis. Stateless, no DB.
app.post("/api/games/analyze", async (c) => {
  const body = await c.req.json().catch(() => null);
  const pgn = typeof body?.pgn === "string" ? body.pgn : "";
  const depth = Math.min(Number(body?.depth ?? 12) || 12, 16);
  const username = typeof body?.username === "string" ? body.username : undefined;
  if (!pgn) return c.json({ error: "pgn required" }, 400);
  try {
    const { evals, accuracy, userColor } = await analyzePgn(pgn, depth, username);
    return c.json(GameAnalysisSchema.parse({ gameId: "local", evals, accuracy, userColor: userColor ?? undefined }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "analysis failed";
    return c.json({ error: msg }, 500);
  }
});

// Slice 1e: ONE DeepSeek call per game. Moves in, all notes + summary out.
app.post("/api/analyze/explain-game", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { moves, gameLine, userColor, accuracy, result, opponent } = body ?? {};
  if (!Array.isArray(moves) || moves.length === 0)
    return c.json({ error: "moves[] required" }, 400);
  try {
    const out = await explainGame({
      moves,
      gameLine: typeof gameLine === "string" ? gameLine : "",
      userColor: userColor ?? null,
      accuracy: Number(accuracy ?? 0),
      result: String(result ?? ""),
      opponent: String(opponent ?? ""),
    });
    return c.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "explain failed";
    console.error(`[POST /api/analyze/explain-game] ${msg}`);
    return c.json({ error: msg }, 502);
  }
});

const port = Number(process.env.PORT ?? 3001);
console.log(`heychess-backend listening on :${port}`);

export default {
  port,
  fetch: app.fetch,
};

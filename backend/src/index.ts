import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chess } from "chess.js";
import { GameAnalysisSchema, GameDetailSchema, GameSchema, PlayerStatsSchema } from "@heychess/contracts";
import { getChessComGamesWithMeta, fetchAllChessComGames, getChessComStats } from "./chesscom.ts";
import { analyzePgn } from "./engine.ts";
import { computeInsights, countAnalyzed, getRecentGamesWithPgn, getStoredAccuracies } from "./insights.ts";
import { explainGame } from "./llm.ts";
import { identifyOpening } from "./openings.ts";
import { isDbEnabled } from "./db/client.ts";
import { auth } from "./auth.ts";
import { attachStoredAccuracy, expireSync, getAccuracySummary, getFreshStoredGames, getGameById, getGamesPage, getLinkedChessHandle, getStoredAnalysis, saveAnalysis, saveAnalysisNotes, setLinkedChessHandle, upsertGames, upsertGamesChunked } from "./db/store.ts";

const app = new Hono();

// Comma-separated list, e.g. "https://heychess-pi.vercel.app,https://heychess.aguowisdom.com"
const frontendUrls = (process.env.FRONTEND_URL ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use("/*", cors({ origin: frontendUrls, credentials: true }));

// Better Auth handler — must come before other /api routes.
// Handles: /api/auth/sign-up/email, /sign-in/email, /sign-out, /get-session, etc.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Every data route below requires a session. Identity always comes from
// the session's user id — never from a query param. The linked chess.com
// handle only selects which external account to fetch from chess.com.
async function requireUserId(c: {
  req: { raw: Request };
}): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// Linked chess account on the user profile.
app.get("/api/profile", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const chessComUsername = await getLinkedChessHandle(userId);
  return c.json({ chessComUsername });
});

app.put("/api/profile", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const handle = typeof body?.chessComUsername === "string" ? body.chessComUsername.trim().toLowerCase() : "";
  if (!handle || handle.length > 32 || !/^[a-z0-9_-]+$/i.test(handle)) {
    return c.json({ error: "valid chess.com username required" }, 400);
  }
  await setLinkedChessHandle(userId, handle);
  return c.json({ chessComUsername: handle });
});

app.get("/api/health", (c) => c.json({ ok: true, service: "heychess-backend" }));

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
// Slice 1a: live Chess.com proxy + Turso cache. DB is write-through:
// every import stores exactly what was asked for, and stored engine
// accuracy wins over chess.com's.
//
// Two modes:
// - ?limit=N (Home, detail fallback, onboarding import): fetch + store the
//   N most recent games. Nothing more.
// - ?page=P&pageSize=S (My Games): read-only over what was imported.
//   A full sync runs ONLY on explicit ?refresh=1 (Sync button, "import
//   all"). Passive page views never import anything.
const fullSyncInFlight = new Set<string>();

async function fullSyncUser(userId: string, chessHandle: string) {
  if (fullSyncInFlight.has(userId)) return;
  fullSyncInFlight.add(userId);
  try {
    const { games, meta } = await fetchAllChessComGames(chessHandle);
    const full = games.map((g) => GameSchema.parse(g));
    await upsertGamesChunked(userId, chessHandle, full, meta);
  } catch (e) {
    console.error(`[fullSync] ${chessHandle}: ${e instanceof Error ? e.message : e}`);
  } finally {
    fullSyncInFlight.delete(userId);
  }
}

app.get("/api/games", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const chessHandle = await getLinkedChessHandle(userId);
  if (!chessHandle) return c.json({ error: "no linked chess.com account" }, 400);

  const pageRaw = c.req.query("page");
  const pageSizeRaw = c.req.query("pageSize");
  const paged = pageRaw !== undefined || pageSizeRaw !== undefined;
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);

  try {
    // ---- Paged mode (My Games): read-only over imported rows ----
    if (paged && isDbEnabled()) {
      // ?full=1 pulls the whole lightweight list (no PGNs) in one shot so the
      // frontend can tab/page locally with zero further requests.
      const fullList = c.req.query("full") === "1";
      const page = Math.max(1, Number(pageRaw ?? 1) || 1);
      const pageSize = fullList
        ? 2000
        : Math.min(Math.max(1, Number(pageSizeRaw ?? 20) || 20), 50);
      const source = (c.req.query("source") ?? "").trim() || undefined;
      const result = (c.req.query("result") ?? "").trim() || undefined;
      // Explicit full sync only: Sync button / "import all". Passive reads
      // never touch chess.com, so the library stays exactly what was imported.
      if (c.req.query("refresh") === "1") {
        try { await expireSync(userId); } catch { /* fall through to sync */ }
        void fullSyncUser(userId, chessHandle).catch(() => {});
      }
      const data = await getGamesPage(userId, chessHandle, { source, result }, page, pageSize);
      if (!data) return c.json({ error: "db unavailable" }, 500);
      // List rows never carry PGNs (4-5MB for 400+ games). Detail loads one
      // game with PGN via /api/games/one.
      const out = data.games.map((g) => {
        const { pgn: _dropped, ...rest } = GameSchema.parse(g);
        return rest;
      });
      const pageCount = Math.max(1, Math.ceil(data.total / pageSize));
      return c.json({
        games: out, total: data.total, page, pageSize, pageCount,
        counts: data.counts, syncing: fullSyncInFlight.has(userId),
      });
    }

    // ---- Slice mode (Home, onboarding import): exactly the N asked for ----
    // DB-first: fresh Turso rows answer instantly, no chess.com call.
    // ?refresh=1 (import) skips the fresh check and pulls N from chess.com.
    const refresh = c.req.query("refresh") === "1";
    if (isDbEnabled() && !refresh) {
      try {
        const fresh = await getFreshStoredGames(userId, chessHandle, limit);
        if (fresh) {
          const out = fresh.map((g) => GameSchema.parse(g));
          return c.json({
            games: out.map((g) => {
              const { pgn: _dropped, ...rest } = g;
              return rest;
            }),
          });
        }
      } catch (e) {
        console.error(`[GET /api/games] db read fallback: ${e instanceof Error ? e.message : e}`);
      }
    }
    const { games, meta } = await getChessComGamesWithMeta(chessHandle, limit);
    const full = games.map((g) => GameSchema.parse(g));
    let out = full.slice(0, limit);
    if (isDbEnabled()) {
      try {
        await upsertGames(userId, chessHandle, out, meta);
        out = await attachStoredAccuracy(userId, out);
      } catch (e) {
        console.error(`[GET /api/games] db fallback: ${e instanceof Error ? e.message : e}`);
      }
    }
    return c.json({
      games: out.map((g) => {
        const { pgn: _dropped, ...rest } = g;
        return rest;
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    if (msg.includes("404")) return c.json({ error: "chess.com user not found" }, 404);
    return c.json({ error: msg }, 502);
  }
});

// Single-game lookup for direct-URL loads. Turso first, full sync fallback.
// Scoped to the caller's own rows.
app.get("/api/games/one", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const chessHandle = await getLinkedChessHandle(userId);
  if (!chessHandle) return c.json({ error: "no linked chess.com account" }, 400);
  const id = (c.req.query("id") ?? "").trim();
  if (!id) return c.json({ error: "id required" }, 400);
  try {
    if (isDbEnabled()) {
      const found = await getGameById(userId, chessHandle, id).catch(() => null);
      if (found) return c.json({ game: GameSchema.parse(found) });
      await fullSyncUser(userId, chessHandle);
      const retry = await getGameById(userId, chessHandle, id).catch(() => null);
      if (retry) return c.json({ game: GameSchema.parse(retry) });
      return c.json({ error: "game not found" }, 404);
    }
    const { games } = await getChessComGamesWithMeta(chessHandle, 50);
    const found = games.find((g) => g.id === id);
    if (!found) return c.json({ error: "game not found" }, 404);
    return c.json({ game: GameSchema.parse(found) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "fetch failed" }, 502);
  }
});

// Player win-rate + totals straight from chess.com /stats (no PGN fetch).
// Public on purpose: onboarding uses it to validate a handle BEFORE it is
// linked to an account. No user data involved.
app.get("/api/player/stats", async (c) => {
  const username = (c.req.query("username") ?? "").trim();
  if (!username) return c.json({ error: "username required" }, 400);
  try {
    const stats = PlayerStatsSchema.parse(await getChessComStats(username));
    return c.json(stats);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    if (msg.includes("404")) return c.json({ error: "chess.com user not found" }, 404);
    return c.json({ error: msg }, 502);
  }
});

// Avg accuracy over every game with a known number: ours first,
// chess.com's review accuracy where we haven't analyzed yet.
// Powers the Home card; nulls only when no game has any accuracy.
app.get("/api/player/accuracy", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  if (!isDbEnabled()) return c.json({ avgAccuracy: null, analyzedCount: 0 });
  try {
    const chessHandle = await getLinkedChessHandle(userId);
    const s = await getAccuracySummary(userId, chessHandle);
    return c.json({ avgAccuracy: s?.avgAccuracy ?? null, analyzedCount: s?.analyzedCount ?? 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return c.json({ error: msg }, 500);
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

// Slice 1d: server Stockfish analysis. Stateless compute, result cached in Turso
// under the caller's user id (when gameId is passed) so the list never re-computes.
app.post("/api/games/analyze", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const pgn = typeof body?.pgn === "string" ? body.pgn : "";
  const depth = Math.min(Number(body?.depth ?? 12) || 12, 16);
  const gameId = typeof body?.gameId === "string" ? body.gameId : undefined;
  if (!pgn) return c.json({ error: "pgn required" }, 400);
  try {
    const chessHandle = await getLinkedChessHandle(userId);
    const { evals, accuracy, userColor } = await analyzePgn(pgn, depth, chessHandle ?? undefined);
    if (isDbEnabled() && gameId) {
      try {
        await saveAnalysis({
          userId,
          gameId,
          chessHandle: chessHandle ?? undefined,
          pgn,
          accuracy,
          userColor,
          depth,
          evals,
        });
      } catch (e) {
        console.error(`[POST /api/games/analyze] db save failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return c.json(GameAnalysisSchema.parse({ gameId: gameId ?? "local", evals, accuracy, userColor: userColor ?? undefined }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "analysis failed";
    return c.json({ error: msg }, 500);
  }
});

// Slice 1e: ONE DeepSeek call per game. Moves in, all notes + summary out.
// Notes are patched onto the stored analysis row (when gameId is passed) so
// reopening the game serves everything from Turso — no re-run.
app.post("/api/analyze/explain-game", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const { moves, gameLine, userColor, accuracy, result, opponent } = body ?? {};
  const gameId = typeof body?.gameId === "string" ? body.gameId : undefined;
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
    if (isDbEnabled() && gameId) {
      try {
        await saveAnalysisNotes(userId, gameId, {
          notes: out.notes,
          takeaways: out.takeaways,
          summary: out.summary,
        });
      } catch (e) {
        console.error(`[POST /api/analyze/explain-game] db save failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return c.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "explain failed";
    console.error(`[POST /api/analyze/explain-game] ${msg}`);
    return c.json({ error: msg }, 502);
  }
});

// Insights page: rulebook pass over the user's most recent stored PGNs.
// No Stockfish here — chess.js replay + material counting only, so any
// limit (10/20/30/50/100) answers in well under a second straight from Turso.
app.get("/api/insights", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const chessHandle = await getLinkedChessHandle(userId);
  if (!chessHandle) return c.json({ error: "no linked chess.com account" }, 400);
  const rawLimit = Number(c.req.query("limit") ?? 30) || 30;
  const limit = Math.min(Math.max(rawLimit, 5), 100);
  if (!isDbEnabled()) return c.json({ error: "db unavailable" }, 500);
  try {
    const rows = await getRecentGamesWithPgn(userId, limit);
    const ids = rows.map((r) => r.id);
    const [analyzed, storedAcc, overall] = await Promise.all([
      countAnalyzed(userId, ids).catch(() => 0),
      getStoredAccuracies(userId, ids).catch(() => new Map<string, number>()),
      getAccuracySummary(userId, chessHandle).catch(() => null),
    ]);
    return c.json(
      computeInsights(rows, chessHandle, analyzed, limit, {
        storedAcc,
        fallbackAccuracy: overall?.avgAccuracy ?? null,
      })
    );
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "insights failed" }, 500);
  }
});

// Stored analysis read path. Detail serves this instantly; 404 (or a row
// shallower than depth 16) means "analyze it".
app.get("/api/games/analysis", async (c) => {
  const userId = await requireUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const gameId = (c.req.query("gameId") ?? "").trim();
  if (!gameId) return c.json({ error: "gameId required" }, 400);
  if (!isDbEnabled()) return c.json({ error: "not stored" }, 404);
  try {
    const stored = await getStoredAnalysis(userId, gameId);
    if (!stored || !Array.isArray(stored.evals) || stored.evals.length === 0) {
      return c.json({ error: "not analyzed" }, 404);
    }
    return c.json({
      game: GameAnalysisSchema.parse({
        gameId: stored.gameId,
        evals: stored.evals,
        accuracy: stored.accuracy,
        userColor: stored.userColor ?? undefined,
        depth: stored.depth,
        notes: (stored.notes as Record<string, string> | null) ?? undefined,
        takeaways: (stored.takeaways as string[] | null) ?? undefined,
        summary: stored.summary ?? undefined,
      }),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "fetch failed" }, 500);
  }
});

const port = Number(process.env.PORT ?? 3001);
console.log(`heychess-backend listening on :${port}`);

export default {
  port,
  // Cloud Run routes to the container IP, not loopback — Bun defaults
  // to localhost here, which passes the startup probe but 404s externally.
  hostname: "0.0.0.0",
  // Stockfish at depth 16 + LLM coach run well past Bun's 10s default.
  idleTimeout: 180,
  fetch: app.fetch,
};

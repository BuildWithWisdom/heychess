import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chess } from "chess.js";
import { GameAnalysisSchema, GameDetailSchema, GameSchema, PlayerStatsSchema } from "@heychess/contracts";
import { getChessComGamesWithMeta, fetchAllChessComGames, getChessComStats } from "./chesscom.ts";
import { analyzePgn } from "./engine.ts";
import { explainGame } from "./llm.ts";
import { identifyOpening } from "./openings.ts";
import { isDbEnabled } from "./db/client.ts";
import { auth } from "./auth.ts";
import { attachStoredAccuracy, expireSync, getAccuracySummary, getFreshStoredGames, getGameById, getGamesPage, getStoredAnalysis, getSyncAge, saveAnalysis, saveAnalysisNotes, upsertGames, upsertGamesChunked } from "./db/store.ts";
const app = new Hono();
app.use("/*", cors({ origin: ["http://localhost:5173"], credentials: true }));
// Better Auth handler — must come before other /api routes.
// Handles: /api/auth/sign-up/email, /sign-in/email, /sign-out, /get-session, etc.
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.get("/healthz", (c) => c.json({ ok: true, service: "heychess-backend" }));
// Parse [%clk 0:09:58.2] / [0:03:42] / [92.5] -> seconds remaining.
function parseClkToSecs(raw) {
    const s = raw.trim();
    if (/^[\d.]+$/.test(s)) {
        const v = Number(s);
        return Number.isFinite(v) ? v : null;
    }
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length === 0 || parts.length > 3)
        return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n)))
        return null;
    let total = 0;
    for (const n of nums)
        total = total * 60 + n;
    return total;
}
// Clocks appear in move order in the PGN movetext: 1. e4 {[%clk 0:10:00]} ...
function extractClocks(pgn) {
    const out = [];
    const re = /\[%clk\s+([^\]]+)\]/g;
    let m;
    while ((m = re.exec(pgn)) !== null) {
        const v = parseClkToSecs(m[1]);
        if (v !== null)
            out.push(v);
    }
    return out;
}
// [TimeControl "600+5"] -> { base: 600, inc: 5 }. Handles "600", "180+2", "-".
function parseTimeControl(pgn) {
    const m = pgn.match(/\[TimeControl\s+"([^"]+)"\]/);
    if (!m)
        return { base: null, inc: 0 };
    const tc = m[1].trim();
    if (tc === "-" || tc === "")
        return { base: null, inc: 0 };
    const plus = tc.split("+");
    const base = Number(plus[0]);
    const inc = plus.length > 1 ? Number(plus[1]) : 0;
    return {
        base: Number.isFinite(base) ? base : null,
        inc: Number.isFinite(inc) ? inc : 0,
    };
}
// Slice 1a: live Chess.com proxy + Turso cache. DB is write-through:
// every sync upserts games, and stored engine accuracy wins over chess.com's.
//
// Two modes:
// - ?limit=N (Home, detail fallback): recent-N slice, old behavior.
// - ?page=P&pageSize=S[&source=][&result=] (My Games): server-side paging over
//   the FULL synced set with true tab counts. Rows come only from Turso;
//   a background full sync fills it, so pages are instant and cheap.
const FULL_SYNC_TTL_MS = 15 * 60 * 1000;
const fullSyncInFlight = new Set();
async function fullSyncUser(username) {
    const lower = username.toLowerCase();
    if (fullSyncInFlight.has(lower))
        return;
    fullSyncInFlight.add(lower);
    try {
        const { games, meta } = await fetchAllChessComGames(username);
        const full = games.map((g) => GameSchema.parse(g));
        await upsertGamesChunked(username, full, meta);
    }
    catch (e) {
        console.error(`[fullSync] ${username}: ${e instanceof Error ? e.message : e}`);
    }
    finally {
        fullSyncInFlight.delete(lower);
    }
}
app.get("/api/games", async (c) => {
    const username = (c.req.query("username") ?? "").trim();
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
    if (!username)
        return c.json({ error: "username required" }, 400);
    const pageRaw = c.req.query("page");
    const pageSizeRaw = c.req.query("pageSize");
    const paged = pageRaw !== undefined || pageSizeRaw !== undefined;
    try {
        // ---- Paged mode (My Games): Turso only, background full sync ----
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
            const refresh = c.req.query("refresh") === "1";
            if (refresh) {
                try {
                    await expireSync(username);
                }
                catch { /* fall through to sync */ }
            }
            const syncAge = await getSyncAge(username).catch(() => null);
            const stale = syncAge === null || syncAge > FULL_SYNC_TTL_MS;
            if (stale)
                void fullSyncUser(username).catch(() => { });
            const data = await getGamesPage(username, { source, result }, page, pageSize);
            if (!data)
                return c.json({ error: "db unavailable" }, 500);
            // List rows never carry PGNs (4-5MB for 400+ games). Detail loads one
            // game with PGN via /api/games/one.
            const out = data.games.map((g) => {
                const { pgn: _dropped, ...rest } = GameSchema.parse(g);
                return rest;
            });
            const pageCount = Math.max(1, Math.ceil(data.total / pageSize));
            return c.json({
                username, games: out, total: data.total, page, pageSize, pageCount,
                counts: data.counts, syncing: stale || fullSyncInFlight.has(username.toLowerCase()),
            });
        }
        // ---- Slice mode (Home, fallbacks): recent-N ----
        // DB-first: fresh Turso rows answer instantly, no chess.com call.
        // Syncs always pull 50 so differing page limits share one cached set.
        // ?refresh=1 (Sync button) skips the fresh check and re-pulls chess.com.
        const refresh = c.req.query("refresh") === "1";
        if (isDbEnabled() && !refresh) {
            try {
                const fresh = await getFreshStoredGames(username, limit);
                if (fresh) {
                    const out = fresh.map((g) => GameSchema.parse(g));
                    return c.json({
                        username,
                        games: out.map((g) => {
                            const { pgn: _dropped, ...rest } = g;
                            return rest;
                        }),
                    });
                }
            }
            catch (e) {
                console.error(`[GET /api/games] db read fallback: ${e instanceof Error ? e.message : e}`);
            }
        }
        const { games, meta } = await getChessComGamesWithMeta(username, Math.max(limit, 50));
        const full = games.map((g) => GameSchema.parse(g));
        let out = full.slice(0, limit);
        if (isDbEnabled()) {
            try {
                await upsertGames(username, full, meta);
                out = await attachStoredAccuracy(out);
            }
            catch (e) {
                console.error(`[GET /api/games] db fallback: ${e instanceof Error ? e.message : e}`);
            }
        }
        return c.json({
            username,
            games: out.map((g) => {
                const { pgn: _dropped, ...rest } = g;
                return rest;
            }),
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "fetch failed";
        if (msg.includes("404"))
            return c.json({ error: "chess.com user not found" }, 404);
        return c.json({ error: msg }, 502);
    }
});
// Single-game lookup for direct-URL loads. Turso first, full sync fallback.
app.get("/api/games/one", async (c) => {
    const username = (c.req.query("username") ?? "").trim();
    const id = (c.req.query("id") ?? "").trim();
    if (!username || !id)
        return c.json({ error: "username+id required" }, 400);
    try {
        if (isDbEnabled()) {
            const found = await getGameById(username, id).catch(() => null);
            if (found)
                return c.json({ game: GameSchema.parse(found) });
            await fullSyncUser(username);
            const retry = await getGameById(username, id).catch(() => null);
            if (retry)
                return c.json({ game: GameSchema.parse(retry) });
            return c.json({ error: "game not found" }, 404);
        }
        const { games } = await getChessComGamesWithMeta(username, 50);
        const found = games.find((g) => g.id === id);
        if (!found)
            return c.json({ error: "game not found" }, 404);
        return c.json({ game: GameSchema.parse(found) });
    }
    catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "fetch failed" }, 502);
    }
});
// Player win-rate + totals straight from chess.com /stats (no PGN fetch).
app.get("/api/player/stats", async (c) => {
    const username = (c.req.query("username") ?? "").trim();
    if (!username)
        return c.json({ error: "username required" }, 400);
    try {
        const stats = PlayerStatsSchema.parse(await getChessComStats(username));
        return c.json(stats);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "fetch failed";
        if (msg.includes("404"))
            return c.json({ error: "chess.com user not found" }, 404);
        return c.json({ error: msg }, 502);
    }
});
// Avg accuracy over EVERY analyzed game in Turso (not the page-limited list).
// Powers the Home card; nulls when nothing is analyzed yet or DB is off.
app.get("/api/player/accuracy", async (c) => {
    const username = (c.req.query("username") ?? "").trim();
    if (!username)
        return c.json({ error: "username required" }, 400);
    if (!isDbEnabled())
        return c.json({ username, avgAccuracy: null, analyzedCount: 0 });
    try {
        const s = await getAccuracySummary(username);
        return c.json({ username, avgAccuracy: s?.avgAccuracy ?? null, analyzedCount: s?.analyzedCount ?? 0 });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "fetch failed";
        return c.json({ error: msg }, 500);
    }
});
// Slice 1c: parse PGN into board-ready moves. Stateless, no DB.
app.post("/api/games/parse", async (c) => {
    const body = await c.req.json().catch(() => null);
    const pgn = typeof body?.pgn === "string" ? body.pgn : "";
    if (!pgn)
        return c.json({ error: "pgn required" }, 400);
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
    }
    catch {
        return c.json({ error: "invalid pgn" }, 400);
    }
});
// Slice 1d: server Stockfish analysis. Stateless compute, result cached in Turso
// when the caller passes gameId (+ username) so the list never re-computes.
app.post("/api/games/analyze", async (c) => {
    const body = await c.req.json().catch(() => null);
    const pgn = typeof body?.pgn === "string" ? body.pgn : "";
    const depth = Math.min(Number(body?.depth ?? 12) || 12, 16);
    const username = typeof body?.username === "string" ? body.username : undefined;
    const gameId = typeof body?.gameId === "string" ? body.gameId : undefined;
    if (!pgn)
        return c.json({ error: "pgn required" }, 400);
    try {
        const { evals, accuracy, userColor } = await analyzePgn(pgn, depth, username);
        if (isDbEnabled() && gameId && username) {
            try {
                await saveAnalysis({
                    gameId,
                    username,
                    pgn,
                    accuracy,
                    userColor,
                    depth,
                    evals,
                });
            }
            catch (e) {
                console.error(`[POST /api/games/analyze] db save failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        return c.json(GameAnalysisSchema.parse({ gameId: gameId ?? "local", evals, accuracy, userColor: userColor ?? undefined }));
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "analysis failed";
        return c.json({ error: msg }, 500);
    }
});
// Slice 1e: ONE DeepSeek call per game. Moves in, all notes + summary out.
// Notes are patched onto the stored analysis row (when gameId is passed) so
// reopening the game serves everything from Turso — no re-run.
app.post("/api/analyze/explain-game", async (c) => {
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
                await saveAnalysisNotes(gameId, {
                    notes: out.notes,
                    takeaways: out.takeaways,
                    summary: out.summary,
                });
            }
            catch (e) {
                console.error(`[POST /api/analyze/explain-game] db save failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        return c.json(out);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "explain failed";
        console.error(`[POST /api/analyze/explain-game] ${msg}`);
        return c.json({ error: msg }, 502);
    }
});
// Stored analysis read path. Detail serves this instantly; 404 (or a row
// shallower than depth 16) means "analyze it".
app.get("/api/games/analysis", async (c) => {
    const gameId = (c.req.query("gameId") ?? "").trim();
    if (!gameId)
        return c.json({ error: "gameId required" }, 400);
    if (!isDbEnabled())
        return c.json({ error: "not stored" }, 404);
    try {
        const stored = await getStoredAnalysis(gameId);
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
                notes: stored.notes ?? undefined,
                takeaways: stored.takeaways ?? undefined,
                summary: stored.summary ?? undefined,
            }),
        });
    }
    catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "fetch failed" }, 500);
    }
});
const port = Number(process.env.PORT ?? 3001);
console.log(`heychess-backend listening on :${port}`);
export default {
    port,
    // Stockfish at depth 16 + LLM coach run well past Bun's 10s default.
    idleTimeout: 180,
    fetch: app.fetch,
};

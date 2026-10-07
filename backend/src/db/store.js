import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client.ts";
import { gameAnalyses, games, syncState } from "./schema.ts";
const now = () => Date.now();
// Serve Turso rows without touching chess.com while the sync is fresh.
// Frontend also caches 60s, so route switches cost zero requests.
const SYNC_TTL_MS = 5 * 60 * 1000;
function userSideIsWhite(pgn, username) {
    if (!pgn)
        return null;
    const w = pgn.match(/\[White\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
    if (!w)
        return null;
    return w === username.toLowerCase();
}
export async function getFreshStoredGames(username, limit) {
    const db = getDb();
    if (!db)
        return null;
    const lower = username.toLowerCase();
    const sync = await db.select().from(syncState).where(eq(syncState.username, lower));
    if (sync.length === 0 || now() - sync[0].lastSyncedAt > SYNC_TTL_MS)
        return null;
    const rows = await db
        .select()
        .from(games)
        .where(eq(games.username, lower))
        .orderBy(desc(games.date))
        .limit(limit);
    if (rows.length === 0)
        return null;
    const ana = await db
        .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
        .from(gameAnalyses)
        .where(inArray(gameAnalyses.gameId, rows.map((r) => r.id)));
    const byId = new Map(ana.map((r) => [r.gameId, r.accuracy]));
    return rows.map((r) => {
        const stored = byId.get(r.id);
        const isWhite = userSideIsWhite(r.pgn, username);
        const providerAcc = isWhite === null
            ? undefined
            : isWhite
                ? (r.chesscomWhiteAccuracy ?? undefined)
                : (r.chesscomBlackAccuracy ?? undefined);
        const accuracy = stored !== undefined && stored !== null
            ? Math.round(stored)
            : providerAcc !== undefined
                ? Math.round(providerAcc)
                : undefined;
        return {
            id: r.id,
            opponent: r.opponent,
            result: r.result,
            timeControl: r.timeControl,
            ...(accuracy !== undefined ? { accuracy } : {}),
            date: new Date(r.date).toISOString(),
            source: (r.source ?? "chesscom"),
            ...(r.pgn ? { pgn: r.pgn } : {}),
        };
    });
}
// Upsert Chess.com games. Chess.com accuracy is instant but spotty;
// our engine accuracy in game_analyses always wins (see attachStoredAccuracy).
export async function upsertGames(username, list, meta) {
    const db = getDb();
    if (!db)
        return;
    const lower = username.toLowerCase();
    const syncedAt = now();
    // ONE round trip: multi-row INSERT. 50 sequential inserts from a laptop to
    // Ohio was ~10s+ alone and tripped Bun's 10s request timeout.
    const rows = list.map((g) => {
        const m = meta.get(g.id);
        return {
            id: g.id,
            username: lower,
            opponent: g.opponent,
            result: g.result,
            timeControl: g.timeControl,
            timeClass: m?.timeClass ?? null,
            date: new Date(g.date).getTime(),
            source: g.source,
            pgn: g.pgn ?? null,
            chesscomWhiteAccuracy: m?.whiteAcc ?? null,
            chesscomBlackAccuracy: m?.blackAcc ?? null,
            createdAt: syncedAt,
            updatedAt: syncedAt,
        };
    });
    if (rows.length > 0) {
        // `excluded.*` = the row proposed for insertion, so each conflicting row
        // updates with its own values (not row 0's).
        await db.insert(games).values(rows).onConflictDoUpdate({
            target: games.id,
            set: {
                opponent: sql `excluded.opponent`,
                result: sql `excluded.result`,
                timeControl: sql `excluded.time_control`,
                timeClass: sql `excluded.time_class`,
                date: sql `excluded.date`,
                pgn: sql `excluded.pgn`,
                chesscomWhiteAccuracy: sql `excluded.chesscom_white_accuracy`,
                chesscomBlackAccuracy: sql `excluded.chesscom_black_accuracy`,
                updatedAt: sql `excluded.updated_at`,
            },
        });
    }
    await db
        .insert(syncState)
        .values({ username: lower, lastSyncedAt: syncedAt, gamesCount: list.length })
        .onConflictDoUpdate({
        target: syncState.username,
        set: { lastSyncedAt: syncedAt, gamesCount: list.length },
    });
}
// Chunked variant for all-time syncs (400+ rows): one INSERT per chunk.
export async function upsertGamesChunked(username, list, meta, chunkSize = 100) {
    for (let i = 0; i < list.length; i += chunkSize) {
        await upsertGames(username, list.slice(i, i + chunkSize), meta);
    }
    await recordSync(username, list.length);
}
export async function recordSync(username, gamesCount) {
    const db = getDb();
    if (!db)
        return;
    const lower = username.toLowerCase();
    const t = now();
    await db
        .insert(syncState)
        .values({ username: lower, lastSyncedAt: t, gamesCount })
        .onConflictDoUpdate({
        target: syncState.username,
        set: { lastSyncedAt: t, gamesCount },
    });
}
// Force the next read to re-sync (Sync button): age the sync out.
export async function expireSync(username) {
    const db = getDb();
    if (!db)
        return;
    const lower = username.toLowerCase();
    await db
        .insert(syncState)
        .values({ username: lower, lastSyncedAt: 0, gamesCount: 0 })
        .onConflictDoUpdate({
        target: syncState.username,
        set: { lastSyncedAt: 0 },
    });
}
// ms since last successful sync, null when never synced.
export async function getSyncAge(username) {
    const db = getDb();
    if (!db)
        return null;
    const rows = await db
        .select()
        .from(syncState)
        .where(eq(syncState.username, username.toLowerCase()));
    if (rows.length === 0)
        return null;
    return now() - rows[0].lastSyncedAt;
}
function mapRowsToGames(rows, accById, username) {
    return rows.map((r) => {
        const stored = accById.get(r.id);
        const isWhite = userSideIsWhite(r.pgn, username);
        const providerAcc = isWhite === null
            ? undefined
            : isWhite
                ? (r.chesscomWhiteAccuracy ?? undefined)
                : (r.chesscomBlackAccuracy ?? undefined);
        const accuracy = stored !== undefined && stored !== null
            ? Math.round(stored)
            : providerAcc !== undefined
                ? Math.round(providerAcc)
                : undefined;
        return {
            id: r.id,
            opponent: r.opponent,
            result: r.result,
            timeControl: r.timeControl,
            ...(accuracy !== undefined ? { accuracy } : {}),
            date: new Date(r.date).toISOString(),
            source: (r.source ?? "chesscom"),
            ...(r.pgn ? { pgn: r.pgn } : {}),
        };
    });
}
// Server-side paged read over the FULL synced set. Counts power the tab
// labels so All is truly all games, not the page on screen.
export async function getGamesPage(username, filter, page, pageSize) {
    const db = getDb();
    if (!db)
        return null;
    const lower = username.toLowerCase();
    const conds = [eq(games.username, lower)];
    if (filter.source)
        conds.push(eq(games.source, filter.source));
    if (filter.result)
        conds.push(eq(games.result, filter.result));
    const where = and(...conds);
    const [countRow] = await db
        .select({
        total: sql `count(*)`,
        wins: sql `sum(case when ${games.result} = 'win' then 1 else 0 end)`,
        losses: sql `sum(case when ${games.result} = 'loss' then 1 else 0 end)`,
        chesscom: sql `sum(case when ${games.source} = 'chesscom' then 1 else 0 end)`,
        lichess: sql `sum(case when ${games.source} = 'lichess' then 1 else 0 end)`,
    })
        .from(games)
        .where(eq(games.username, lower));
    const [totalRow] = await db
        .select({ n: sql `count(*)` })
        .from(games)
        .where(where);
    const rows = await db
        .select()
        .from(games)
        .where(where)
        .orderBy(desc(games.date))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    const ana = rows.length === 0
        ? []
        : await db
            .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
            .from(gameAnalyses)
            .where(inArray(gameAnalyses.gameId, rows.map((r) => r.id)));
    const accById = new Map(ana.map((r) => [r.gameId, r.accuracy]));
    return {
        total: Number(totalRow?.n ?? 0),
        games: mapRowsToGames(rows, accById, username),
        counts: {
            all: Number(countRow?.total ?? 0),
            win: Number(countRow?.wins ?? 0),
            loss: Number(countRow?.losses ?? 0),
            chesscom: Number(countRow?.chesscom ?? 0),
            lichess: Number(countRow?.lichess ?? 0),
        },
    };
}
// Single-game lookup for direct-URL loads (game older than any page).
export async function getGameById(username, id) {
    const db = getDb();
    if (!db)
        return null;
    const rows = await db.select().from(games).where(eq(games.id, id)).limit(1);
    if (rows.length === 0)
        return null;
    const ana = await db
        .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
        .from(gameAnalyses)
        .where(eq(gameAnalyses.gameId, id));
    const accById = new Map(ana.map((r) => [r.gameId, r.accuracy]));
    return mapRowsToGames(rows, accById, username)[0] ?? null;
}
// Read path for the analysis cache. Null = never analyzed (or DB off).
// Detail serves this instantly instead of re-running Stockfish.
export async function getStoredAnalysis(gameId) {
    const db = getDb();
    if (!db)
        return null;
    const rows = await db.select().from(gameAnalyses).where(eq(gameAnalyses.gameId, gameId)).limit(1);
    if (rows.length === 0)
        return null;
    const r = rows[0];
    const safe = (raw) => {
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    };
    return {
        gameId: r.gameId,
        username: r.username,
        accuracy: r.accuracy,
        userColor: r.userColor ?? null,
        depth: r.depth,
        evals: safe(r.evals),
        notes: safe(r.notes),
        takeaways: safe(r.takeaways),
        summary: r.summary,
        analyzedAt: r.analyzedAt,
    };
}
// The coach's output lands in a separate request from the engine result, so
// notes are patched onto the stored row instead of re-inserted.
export async function saveAnalysisNotes(gameId, notes) {
    const db = getDb();
    if (!db)
        return;
    await db
        .update(gameAnalyses)
        .set({
        notes: JSON.stringify(notes.notes),
        takeaways: JSON.stringify(notes.takeaways),
        summary: notes.summary ?? null,
    })
        .where(eq(gameAnalyses.gameId, gameId));
}
// Average over EVERY game the user has analyzed (all of Turso), not just
// the page-limited list the frontend happens to hold.
export async function getAccuracySummary(username) {
    const db = getDb();
    if (!db)
        return null;
    const rows = await db
        .select({ accuracy: gameAnalyses.accuracy })
        .from(gameAnalyses)
        .where(eq(gameAnalyses.username, username.toLowerCase()));
    if (rows.length === 0)
        return { avgAccuracy: null, analyzedCount: 0 };
    const avg = Math.round(rows.reduce((s, r) => s + r.accuracy, 0) / rows.length);
    return { avgAccuracy: avg, analyzedCount: rows.length };
}
// Our engine accuracy overrides chess.com's. Returns games with accuracy set.
export async function attachStoredAccuracy(list) {
    const db = getDb();
    if (!db || list.length === 0)
        return list;
    const rows = await db
        .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
        .from(gameAnalyses)
        .where(inArray(gameAnalyses.gameId, list.map((g) => g.id)));
    if (rows.length === 0)
        return list;
    const byId = new Map(rows.map((r) => [r.gameId, r.accuracy]));
    return list.map((g) => {
        const stored = byId.get(g.id);
        if (stored !== undefined && stored !== null)
            return { ...g, accuracy: Math.round(stored) };
        return g;
    });
}
export async function saveAnalysis(opts) {
    const db = getDb();
    if (!db)
        return;
    const t = now();
    const lower = opts.username.toLowerCase();
    // FK requires the parent game row — insert a minimal one if sync hasn't seen it.
    await db
        .insert(games)
        .values({
        id: opts.gameId,
        username: lower,
        opponent: opts.opponent ?? "Unknown",
        result: opts.result ?? "draw",
        timeControl: opts.timeControl ?? "Unknown",
        timeClass: null,
        date: opts.date ? new Date(opts.date).getTime() : t,
        source: "chesscom",
        pgn: opts.pgn ?? null,
        chesscomWhiteAccuracy: null,
        chesscomBlackAccuracy: null,
        createdAt: t,
        updatedAt: t,
    })
        .onConflictDoNothing();
    await db
        .insert(gameAnalyses)
        .values({
        gameId: opts.gameId,
        username: lower,
        accuracy: opts.accuracy,
        userColor: opts.userColor,
        depth: opts.depth,
        evals: JSON.stringify(opts.evals),
        notes: opts.notes !== undefined ? JSON.stringify(opts.notes) : null,
        takeaways: opts.takeaways !== undefined ? JSON.stringify(opts.takeaways) : null,
        summary: opts.summary ?? null,
        analyzedAt: t,
    })
        .onConflictDoUpdate({
        target: gameAnalyses.gameId,
        set: {
            username: lower,
            accuracy: opts.accuracy,
            userColor: opts.userColor,
            depth: opts.depth,
            evals: JSON.stringify(opts.evals),
            notes: opts.notes !== undefined ? JSON.stringify(opts.notes) : null,
            takeaways: opts.takeaways !== undefined ? JSON.stringify(opts.takeaways) : null,
            summary: opts.summary ?? null,
            analyzedAt: t,
        },
    });
}

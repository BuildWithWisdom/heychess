import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Game } from "@heychess/contracts";
import { getDb } from "./client.ts";
import { gameAnalyses, games, syncState, user } from "./schema.ts";
import type { ChessComGameMeta } from "../chesscom.ts";

const now = () => Date.now();
// Serve Turso rows without touching chess.com while the sync is fresh.
// Frontend also caches 60s, so route switches cost zero requests.
const SYNC_TTL_MS = 5 * 60 * 1000;

// Every read/write here is scoped to a user_id from the session.
// The chess handle only selects WHICH external account to fetch from
// chess.com — it is never identity and never access control.

// ---- Linked chess accounts (on the user profile) ----

export async function getLinkedChessHandle(userId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select({ chessComUsername: user.chessComUsername })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.chessComUsername ?? null;
}

export async function setLinkedChessHandle(userId: string, handle: string) {
  const db = getDb();
  if (!db) return;
  await db
    .update(user)
    .set({ chessComUsername: handle.toLowerCase() })
    .where(eq(user.id, userId));
}

function userSideIsWhite(pgn: string | null, chessHandle: string): boolean | null {
  if (!pgn) return null;
  const w = pgn.match(/\[White\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
  if (!w) return null;
  return w === chessHandle.toLowerCase();
}

export async function getFreshStoredGames(
  userId: string,
  chessHandle: string,
  limit: number
): Promise<Game[] | null> {
  const db = getDb();
  if (!db) return null;
  const sync = await db.select().from(syncState).where(eq(syncState.userId, userId));
  if (sync.length === 0 || now() - sync[0].lastSyncedAt > SYNC_TTL_MS) return null;
  const rows = await db
    .select()
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.date))
    .limit(limit);
  if (rows.length === 0) return null;
  const ana = await db
    .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
    .from(gameAnalyses)
    .where(
      and(
        eq(gameAnalyses.userId, userId),
        inArray(
          gameAnalyses.gameId,
          rows.map((r) => r.id)
        )
      )
    );
  const byId = new Map(ana.map((r) => [r.gameId, r.accuracy]));
  return rows.map((r) => {
    const stored = byId.get(r.id);
    const isWhite = userSideIsWhite(r.pgn, chessHandle);
    const providerAcc =
      isWhite === null
        ? undefined
        : isWhite
          ? (r.chesscomWhiteAccuracy ?? undefined)
          : (r.chesscomBlackAccuracy ?? undefined);
    const accuracy =
      stored !== undefined && stored !== null
        ? Math.round(stored)
        : providerAcc !== undefined
          ? Math.round(providerAcc)
          : undefined;
    return {
      id: r.id,
      opponent: r.opponent,
      result: r.result as Game["result"],
      timeControl: r.timeControl,
      ...(accuracy !== undefined ? { accuracy } : {}),
      date: new Date(r.date).toISOString(),
      source: (r.source ?? "chesscom") as Game["source"],
      ...(r.pgn ? { pgn: r.pgn } : {}),
    };
  });
}

// Upsert Chess.com games under the owning user. Chess.com accuracy is
// instant but spotty; our engine accuracy in game_analyses always wins
// (see attachStoredAccuracy).
export async function upsertGames(
  userId: string,
  chessHandle: string,
  list: Game[],
  meta: Map<string, ChessComGameMeta>
) {
  const db = getDb();
  if (!db) return;
  const lower = chessHandle.toLowerCase();
  const syncedAt = now();
  // ONE round trip: multi-row INSERT. 50 sequential inserts from a laptop to
  // Ohio was ~10s+ alone and tripped Bun's 10s request timeout.
  const rows = list.map((g) => {
    const m = meta.get(g.id);
    return {
      userId,
      id: g.id,
      chessHandle: lower,
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
      target: [games.userId, games.id],
      set: {
        chessHandle: sql`excluded.chess_handle`,
        opponent: sql`excluded.opponent`,
        result: sql`excluded.result`,
        timeControl: sql`excluded.time_control`,
        timeClass: sql`excluded.time_class`,
        date: sql`excluded.date`,
        pgn: sql`excluded.pgn`,
        chesscomWhiteAccuracy: sql`excluded.chesscom_white_accuracy`,
        chesscomBlackAccuracy: sql`excluded.chesscom_black_accuracy`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  }
  await db
    .insert(syncState)
    .values({ userId, chessHandle: lower, lastSyncedAt: syncedAt, gamesCount: list.length })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { chessHandle: lower, lastSyncedAt: syncedAt, gamesCount: list.length },
    });
}

// Chunked variant for all-time syncs (400+ rows): one INSERT per chunk.
export async function upsertGamesChunked(
  userId: string,
  chessHandle: string,
  list: Game[],
  meta: Map<string, ChessComGameMeta>,
  chunkSize = 100
) {
  for (let i = 0; i < list.length; i += chunkSize) {
    await upsertGames(userId, chessHandle, list.slice(i, i + chunkSize), meta);
  }
  await recordSync(userId, chessHandle, list.length);
}

export async function recordSync(userId: string, chessHandle: string, gamesCount: number) {
  const db = getDb();
  if (!db) return;
  const t = now();
  await db
    .insert(syncState)
    .values({ userId, chessHandle: chessHandle.toLowerCase(), lastSyncedAt: t, gamesCount })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { chessHandle: chessHandle.toLowerCase(), lastSyncedAt: t, gamesCount },
    });
}

// Force the next read to re-sync (Sync button): age the sync out.
export async function expireSync(userId: string) {
  const db = getDb();
  if (!db) return;
  await db
    .insert(syncState)
    .values({ userId, lastSyncedAt: 0, gamesCount: 0 })
    .onConflictDoUpdate({
      target: syncState.userId,
      set: { lastSyncedAt: 0 },
    });
}

// ms since last successful sync, null when never synced.
export async function getSyncAge(userId: string): Promise<number | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db.select().from(syncState).where(eq(syncState.userId, userId));
  if (rows.length === 0) return null;
  return now() - rows[0].lastSyncedAt;
}

type GameRow = typeof games.$inferSelect;

function mapRowsToGames(
  rows: GameRow[],
  accById: Map<string, number>,
  chessHandle: string
): Game[] {
  return rows.map((r) => {
    const stored = accById.get(r.id);
    const isWhite = userSideIsWhite(r.pgn, chessHandle);
    const providerAcc =
      isWhite === null
        ? undefined
        : isWhite
          ? (r.chesscomWhiteAccuracy ?? undefined)
          : (r.chesscomBlackAccuracy ?? undefined);
    const accuracy =
      stored !== undefined && stored !== null
        ? Math.round(stored)
        : providerAcc !== undefined
          ? Math.round(providerAcc)
          : undefined;
    return {
      id: r.id,
      opponent: r.opponent,
      result: r.result as Game["result"],
      timeControl: r.timeControl,
      ...(accuracy !== undefined ? { accuracy } : {}),
      date: new Date(r.date).toISOString(),
      source: (r.source ?? "chesscom") as Game["source"],
      ...(r.pgn ? { pgn: r.pgn } : {}),
    };
  });
}

export type PageCounts = { all: number; win: number; loss: number; chesscom: number; lichess: number };

// Server-side paged read over the FULL synced set. Counts power the tab
// labels so All is truly all games, not the page on screen.
export async function getGamesPage(
  userId: string,
  chessHandle: string,
  filter: { source?: string; result?: string },
  page: number,
  pageSize: number
): Promise<{ total: number; games: Game[]; counts: PageCounts } | null> {
  const db = getDb();
  if (!db) return null;
  const conds = [eq(games.userId, userId)];
  if (filter.source) conds.push(eq(games.source, filter.source));
  if (filter.result) conds.push(eq(games.result, filter.result));
  const where = and(...conds);

  const [countRow] = await db
    .select({
      total: sql<number>`count(*)`,
      wins: sql<number>`sum(case when ${games.result} = 'win' then 1 else 0 end)`,
      losses: sql<number>`sum(case when ${games.result} = 'loss' then 1 else 0 end)`,
      chesscom: sql<number>`sum(case when ${games.source} = 'chesscom' then 1 else 0 end)`,
      lichess: sql<number>`sum(case when ${games.source} = 'lichess' then 1 else 0 end)`,
    })
    .from(games)
    .where(eq(games.userId, userId));

  const [totalRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(games)
    .where(where);

  const rows = await db
    .select()
    .from(games)
    .where(where)
    .orderBy(desc(games.date))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const ana =
    rows.length === 0
      ? []
      : await db
          .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
          .from(gameAnalyses)
          .where(
            and(
              eq(gameAnalyses.userId, userId),
              inArray(
                gameAnalyses.gameId,
                rows.map((r) => r.id)
              )
            )
          );
  const accById = new Map(ana.map((r) => [r.gameId, r.accuracy]));
  return {
    total: Number(totalRow?.n ?? 0),
    games: mapRowsToGames(rows, accById, chessHandle),
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
export async function getGameById(userId: string, chessHandle: string, id: string): Promise<Game | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, id)))
    .limit(1);
  if (rows.length === 0) return null;
  const ana = await db
    .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
    .from(gameAnalyses)
    .where(and(eq(gameAnalyses.userId, userId), eq(gameAnalyses.gameId, id)));
  const accById = new Map(ana.map((r) => [r.gameId, r.accuracy]));
  return mapRowsToGames(rows, accById, chessHandle)[0] ?? null;
}

export type StoredAnalysis = {
  gameId: string;
  accuracy: number;
  userColor: "w" | "b" | null;
  depth: number;
  evals: unknown;
  notes: unknown;
  takeaways: unknown;
  summary: string | null;
  analyzedAt: number;
};

// Read path for the analysis cache. Null = never analyzed (or DB off).
// Detail serves this instantly instead of re-running Stockfish.
export async function getStoredAnalysis(userId: string, gameId: string): Promise<StoredAnalysis | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(gameAnalyses)
    .where(and(eq(gameAnalyses.userId, userId), eq(gameAnalyses.gameId, gameId)))
    .limit(1);
  if (rows.length === 0) return null;
  const r = rows[0];
  const safe = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    gameId: r.gameId,
    accuracy: r.accuracy,
    userColor: (r.userColor as "w" | "b" | null) ?? null,
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
export async function saveAnalysisNotes(
  userId: string,
  gameId: string,
  notes: { notes: unknown; takeaways: unknown; summary?: string }
) {
  const db = getDb();
  if (!db) return;
  await db
    .update(gameAnalyses)
    .set({
      notes: JSON.stringify(notes.notes),
      takeaways: JSON.stringify(notes.takeaways),
      summary: notes.summary ?? null,
    })
    .where(and(eq(gameAnalyses.userId, userId), eq(gameAnalyses.gameId, gameId)));
}

// Average over every game we know an accuracy for: our engine result wins,
// chess.com's review accuracy fills the gaps. Same rule as the list rows,
// so the card and the table never disagree.
export async function getAccuracySummary(
  userId: string,
  chessHandle?: string | null
): Promise<{ avgAccuracy: number | null; analyzedCount: number } | null> {
  const db = getDb();
  if (!db) return null;
  const ana = await db
    .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
    .from(gameAnalyses)
    .where(eq(gameAnalyses.userId, userId));
  const storedById = new Map(ana.map((r) => [r.gameId, r.accuracy]));
  const lower = (chessHandle ?? "").toLowerCase();
  const rows = await db
    .select()
    .from(games)
    .where(eq(games.userId, userId));
  const vals: number[] = [];
  for (const r of rows) {
    const stored = storedById.get(r.id);
    if (stored !== undefined && stored !== null && Number.isFinite(stored)) {
      vals.push(stored);
      continue;
    }
    const isWhite = r.pgn ? userSideIsWhite(r.pgn, lower) : null;
    const provider =
      isWhite === null
        ? undefined
        : isWhite
          ? (r.chesscomWhiteAccuracy ?? undefined)
          : (r.chesscomBlackAccuracy ?? undefined);
    if (provider !== undefined && Number.isFinite(provider)) vals.push(provider);
  }
  if (vals.length === 0) return { avgAccuracy: null, analyzedCount: 0 };
  const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  return { avgAccuracy: avg, analyzedCount: vals.length };
}

// Our engine accuracy overrides chess.com's. Returns games with accuracy set.
export async function attachStoredAccuracy(userId: string, list: Game[]): Promise<Game[]> {
  const db = getDb();
  if (!db || list.length === 0) return list;
  const rows = await db
    .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
    .from(gameAnalyses)
    .where(
      and(
        eq(gameAnalyses.userId, userId),
        inArray(
          gameAnalyses.gameId,
          list.map((g) => g.id)
        )
      )
    );
  if (rows.length === 0) return list;
  const byId = new Map(rows.map((r) => [r.gameId, r.accuracy]));
  return list.map((g) => {
    const stored = byId.get(g.id);
    if (stored !== undefined && stored !== null)
      return { ...g, accuracy: Math.round(stored) };
    return g;
  });
}

export async function saveAnalysis(opts: {
  userId: string;
  gameId: string;
  chessHandle?: string;
  opponent?: string;
  result?: string;
  timeControl?: string;
  date?: string;
  pgn?: string;
  accuracy: number;
  userColor: string | null;
  depth: number;
  evals: unknown;
  notes?: unknown;
  takeaways?: unknown;
  summary?: string;
}) {
  const db = getDb();
  if (!db) return;
  const t = now();
  // FK requires the parent game row — insert a minimal one if sync hasn't seen it.
  await db
    .insert(games)
    .values({
      userId: opts.userId,
      id: opts.gameId,
      chessHandle: opts.chessHandle?.toLowerCase() ?? null,
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
      userId: opts.userId,
      gameId: opts.gameId,
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
      target: [gameAnalyses.userId, gameAnalyses.gameId],
      set: {
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

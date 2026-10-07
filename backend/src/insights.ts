import { and, desc, eq, inArray } from "drizzle-orm";
import { Chess } from "chess.js";
import { getDb } from "./db/client.ts";
import { gameAnalyses, games } from "./db/schema.ts";
import { identifyOpening } from "./openings.ts";
import type { InsightsResponse } from "@heychess/contracts";

const PIECE_VALS: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function materialOf(board: string): { w: number; b: number } {
  let w = 0;
  let b = 0;
  for (const ch of board) {
    if (ch === "/" || /\d/.test(ch)) continue;
    const v = PIECE_VALS[ch.toLowerCase()] ?? 0;
    if (ch === ch.toLowerCase()) b += v;
    else w += v;
  }
  return { w, b };
}

function sideIsWhite(pgn: string, handle: string): boolean | null {
  const w = pgn.match(/\[White\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
  const b = pgn.match(/\[Black\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
  const lower = handle.toLowerCase();
  if (w === lower) return true;
  if (b === lower) return false;
  return null;
}

type RecentRow = {
  id: string;
  opponent: string;
  result: string;
  date: number;
  pgn: string | null;
  chesscomWhiteAccuracy: number | null;
  chesscomBlackAccuracy: number | null;
};

export async function getRecentGamesWithPgn(
  userId: string,
  limit: number
): Promise<RecentRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: games.id,
      opponent: games.opponent,
      result: games.result,
      date: games.date,
      pgn: games.pgn,
      chesscomWhiteAccuracy: games.chesscomWhiteAccuracy,
      chesscomBlackAccuracy: games.chesscomBlackAccuracy,
    })
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.date))
    .limit(limit);
  return rows;
}

export async function countAnalyzed(
  userId: string,
  ids: string[]
): Promise<number> {
  const db = getDb();
  if (!db || ids.length === 0) return 0;
  const rows = await db
    .select({ gameId: gameAnalyses.gameId })
    .from(gameAnalyses)
    .where(
      and(
        eq(gameAnalyses.userId, userId),
        inArray(gameAnalyses.gameId, ids)
      )
    );
  return new Set(rows.map((r) => r.gameId)).size;
}

// Our engine accuracy for these games, where it exists. The caller merges
// it over chess.com's numbers (ours wins) exactly like the rest of the app.
export async function getStoredAccuracies(
  userId: string,
  ids: string[]
): Promise<Map<string, number>> {
  const db = getDb();
  if (!db || ids.length === 0) return new Map();
  const rows = await db
    .select({ gameId: gameAnalyses.gameId, accuracy: gameAnalyses.accuracy })
    .from(gameAnalyses)
    .where(
      and(
        eq(gameAnalyses.userId, userId),
        inArray(gameAnalyses.gameId, ids)
      )
    );
  return new Map(rows.map((r) => [r.gameId, r.accuracy]));
}

type Discovery = InsightsResponse["discoveries"][number];

export function computeInsights(
  rows: RecentRow[],
  chessHandle: string,
  analyzed: number,
  limit: number,
  quality: { storedAcc: Map<string, number>; fallbackAccuracy: number | null } = {
    storedAcc: new Map(),
    fallbackAccuracy: null,
  }
): InsightsResponse {
  const total = rows.length;
  const lastUpdated =
    total > 0 ? new Date(Math.max(...rows.map((r) => r.date))).toISOString() : null;

  // Per-game rulebook pass. Games whose PGN won't parse still count in
  // `total` but contribute no patterns.
  let parsed = 0;
  const queenEarlyGames = new Set<string>();
  const missedDefenseGames = new Set<string>();
  const tacticalRiskGames = new Set<string>();
  const slowEndgameGames = new Set<string>();
  const castledGames = new Set<string>();
  const openingCounts = new Map<string, number>();
  const discoveries: Discovery[] = [];

  for (const row of rows) {
    if (!row.pgn) continue;
    let chess: Chess;
    try {
      chess = new Chess();
      chess.loadPgn(row.pgn);
    } catch {
      continue;
    }
    parsed++;
    const verbose = chess.history({ verbose: true }) as Array<{
      san: string;
      piece: string;
      from: string;
      moveNo?: number;
    }>;
    const sans = verbose.map((m) => m.san);
    const isWhite = sideIsWhite(row.pgn, chessHandle);

    // Opening trends — longest ECO prefix match, offline.
    const opening = identifyOpening(sans);
    if (opening.name !== "Unknown Opening") {
      openingCounts.set(opening.name, (openingCounts.get(opening.name) ?? 0) + 1);
    }

    if (isWhite === null) continue;
    const userIsWhite = isWhite;

    // Queen-early: first user queen move at moveNo <= 6 with no user
    // knight/bishop move before it.
    let userMinorMoved = false;
    let queenEarlySan: { moveNo: number; san: string } | null = null;
    // Castling + material replay in one pass.
    // Hanging detection watches the REPLY, not your move: moving a piece
    // never loses material — the loss lands when the opponent captures
    // what you left hanging. So after every opponent reply we compare
    // your material now vs right after your previous move.
    let userCastled = false;
    const replay = new Chess();
    const userMat = (fen: string) => {
      const m = materialOf(fen.split(" ")[0]);
      return userIsWhite ? m.w - m.b : m.b - m.w;
    };
    let matBeforeUserMove = userMat(replay.fen());
    let lastUserMove: { moveNo: number; san: string } | null = null;
    let userDropWorst = 0;
    let userDropExample: { moveNo: number; san: string } | null = null;
    let userSacced = false;

    for (let i = 0; i < verbose.length; i++) {
      const mv = verbose[i];
      const moverIsWhite = i % 2 === 0;
      const moverIsUser = moverIsWhite === userIsWhite;
      const moveNo = Math.floor(i / 2) + 1;

      if (moverIsUser && (mv.piece === "n" || mv.piece === "b") && moveNo <= 6) {
        userMinorMoved = true;
      }
      if (
        moverIsUser &&
        mv.piece === "q" &&
        moveNo <= 6 &&
        !userMinorMoved &&
        !queenEarlySan
      ) {
        queenEarlySan = { moveNo, san: mv.san };
      }
      if (moverIsUser && mv.piece === "k" && (mv.san === "O-O" || mv.san === "O-O-O")) {
        userCastled = true;
      }

      const beforeMat = moverIsUser ? userMat(replay.fen()) : 0;
      try {
        replay.move(mv.san);
      } catch {
        break;
      }
      const nowMat = userMat(replay.fen());
      if (moverIsUser) {
        // Your own move: a net-negative capture here is a speculative
        // sacrifice (giving a knight for two pawns, etc.). Pawns ignored —
        // only pieces (200+ = minor piece and up) count.
        if (nowMat - beforeMat <= -200) userSacced = true;
        matBeforeUserMove = beforeMat;
        lastUserMove = { moveNo, san: mv.san };
      } else if (lastUserMove) {
        // Net loss across your move + opponent reply. Normal trades net to
        // ~0 (you take, they recapture) so they don't count. Only real
        // free piece losses count. Pawns ignored.
        const loss = matBeforeUserMove - nowMat;
        if (loss >= 200 && loss > userDropWorst) {
          userDropWorst = loss;
          userDropExample = lastUserMove;
        }
      }
    }

    if (queenEarlySan) queenEarlyGames.add(row.id);
    if (userCastled) castledGames.add(row.id);
    // Only costly hangs count: a piece drop in a game you lost.
    // Hangs you recovered from (won/drew anyway) don't mark the game.
    if (userDropExample && row.result === "loss") {
      missedDefenseGames.add(row.id);
      if (discoveries.length < 7) {
        discoveries.push({
          gameId: row.id,
          opponent: row.opponent,
          moveNo: userDropExample.moveNo,
          san: userDropExample.san,
          label: "Missed defensive resource",
        });
      }
    }
    if (userSacced && row.result !== "win") tacticalRiskGames.add(row.id);

    // Slow endgame: long game (30+ moves) not won despite no worse
    // material at the end — a conversion/passivity proxy, no clock needed.
    const gameMoves = Math.ceil(verbose.length / 2);
    if (gameMoves >= 30 && row.result !== "win") {
      const end = materialOf(replay.fen().split(" ")[0]);
      const userEnd = userIsWhite ? end.w - end.b : end.b - end.w;
      if (userEnd >= -100) slowEndgameGames.add(row.id);
    }
  }

  const n = Math.max(1, parsed);
  const pct = (x: number) => Math.max(5, Math.min(98, Math.round((x / n) * 100)));
  // Each bar measures something genuinely visible in game scores:
  // tactical = your average move quality in the range (our engine number
  // where a game was analyzed, chess.com's review number otherwise),
  // positional = how often you castle, defensive = how often you play
  // clean games with no hanging piece (missedDefense), endgame =
  // converting long games.
  const qualityVals: number[] = [];
  for (const r of rows) {
    const stored = quality.storedAcc.get(r.id);
    if (stored !== undefined && Number.isFinite(stored)) {
      qualityVals.push(stored);
      continue;
    }
    const isWhite = r.pgn ? sideIsWhite(r.pgn, chessHandle) : null;
    const provider =
      isWhite === null
        ? undefined
        : isWhite
          ? (r.chesscomWhiteAccuracy ?? undefined)
          : (r.chesscomBlackAccuracy ?? undefined);
    if (provider !== undefined && Number.isFinite(provider)) qualityVals.push(provider);
  }
  const qualityAvg =
    qualityVals.length > 0
      ? qualityVals.reduce((s, v) => s + v, 0) / qualityVals.length
      : (quality.fallbackAccuracy ?? 0);
  const clampBar = (v: number) => Math.max(5, Math.min(98, Math.round(v)));
  const quickStats = {
    tactical: parsed === 0 ? 0 : clampBar(qualityAvg),
    positional: parsed === 0 ? 0 : pct(castledGames.size),
    defensive: parsed === 0 ? 0 : pct(parsed - missedDefenseGames.size),
    endgame: 0,
  };
  const longGames = rows.filter((r) => {
    if (!r.pgn) return false;
    try {
      const c = new Chess();
      c.loadPgn(r.pgn);
      return Math.ceil(c.history().length / 2) >= 30;
    } catch {
      return false;
    }
  }).length;
  const longWins = longGames - slowEndgameGames.size;
  quickStats.endgame =
    parsed === 0
      ? 0
      : longGames > 0
        ? Math.max(5, Math.min(98, Math.round((longWins / longGames) * 100)))
        : quickStats.defensive;

  const statLabels: Record<keyof typeof quickStats, string> = {
    tactical: "Accuracy",
    positional: "King Safety",
    defensive: "Defense",
    endgame: "Late wins",
  };
  const entries = (Object.keys(quickStats) as Array<keyof typeof quickStats>).map((k) => ({
    k,
    v: quickStats[k],
  }));
  const best = entries.reduce((a, b) => (b.v > a.v ? b : a), entries[0]);
  const worst = entries.reduce((a, b) => (b.v < a.v ? b : a), entries[0]);

  const patternKinds = [
    queenEarlyGames.size > 0,
    missedDefenseGames.size > 0,
    tacticalRiskGames.size > 0,
    slowEndgameGames.size > 0,
  ].filter(Boolean).length;

  // Group by opening family ("Sicilian Defense: Najdorf" -> "Sicilian
  // Defense") so variations don't split the count. Full names give
  // 2/30 fake trends; families give real ones (Sicilian 12/50).
  let topOpening: { name: string; count: number } | null = null;
  const familyCounts = new Map<string, number>();
  for (const [name, count] of openingCounts) {
    const family = name.split(":")[0].trim();
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + count);
  }
  for (const [name, count] of familyCounts) {
    if (!topOpening || count > topOpening.count) topOpening = { name, count };
  }
  // 2/30 is not a trend. Need 3+ games in the top family.
  if (topOpening && topOpening.count < 3) {
    topOpening = null;
  }

  const profiles: Record<string, { title: string; blurb: string }> = {
    tactical: {
      title: "Aggressive Improviser",
      blurb:
        "You tend to play actively, look for tactical opportunities, and prefer attacking chances over slow, positional play.",
    },
    positional: {
      title: "Solid Positional",
      blurb:
        "You develop soundly, castle early, and prefer building small, lasting advantages over sharp complications.",
    },
    defensive: {
      title: "Resilient Defender",
      blurb:
        "You rarely hang material and hold difficult positions well — your games are decided by patience more than tactics.",
    },
    endgame: {
      title: "Patient Grinder",
      blurb:
        "Your long games are a strength: you convert better endgames and save worse ones more often than not.",
    },
  };
  const profileKey = parsed === 0 ? "tactical" : best.k;
  const profile = profiles[profileKey];

  const keyInsights: InsightsResponse["keyInsights"] = [
    {
      kind: "patterns",
      title: "Recurring Patterns",
      subtitle: patternKinds === 0 ? "No patterns yet" : `${patternKinds} pattern${patternKinds === 1 ? "" : "s"} detected`,
    },
    {
      kind: "openings",
      title: "Opening Trends",
      subtitle: topOpening ? `${topOpening.name} (${topOpening.count} games)` : "Varied — no main opening",
    },
    { kind: "strength", title: "Biggest Strength", subtitle: statLabels[best.k] },
    { kind: "area", title: "Focus Area", subtitle: statLabels[worst.k] },
  ];

  const m = discoveries.length;
  const discoveriesSummary =
    total === 0
      ? "Import games to surface the positions costing you points."
      : m === 0
        ? `No missed defensive resources found in your last ${total} games — nice and solid.`
        : `We've found ${m} position${m === 1 ? "" : "s"} from your last ${total} games where you missed defensive resources.`;

  return {
    limit,
    total,
    analyzed,
    lastUpdated,
    profile,
    quickStats,
    keyInsights,
    discoveries,
    discoveriesSummary,
    patternCounts: {
      queenEarly: queenEarlyGames.size,
      missedDefense: missedDefenseGames.size,
      tacticalRisk: tacticalRiskGames.size,
      slowEndgame: slowEndgameGames.size,
    },
    topOpening,
  };
}

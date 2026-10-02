// Real chess phase detection: book + development for Opening,
// Tapered-Eval material count for Endgame. Middlegame is what's left.
//
// - Opening ends when development is done AND theory is over:
//   oEnd = max(bookMoves, first move with development >= 6).
//   Leaving book early does NOT fast-forward to middlegame.
// - Endgame starts at the first move after the opening where material
//   is actually low (Stockfish-style phase <= 10, or queenless <= 14).
// - Short games (e.g. mate in 10) stay all-Opening; Mid/End are empty.

export type PhaseMove = { fen: string };

const START_SQUARES: { sq: string; piece: string; color: "w" | "b" }[] = [
  { sq: "b1", piece: "N", color: "w" },
  { sq: "g1", piece: "N", color: "w" },
  { sq: "c1", piece: "B", color: "w" },
  { sq: "f1", piece: "B", color: "w" },
  { sq: "b8", piece: "N", color: "b" },
  { sq: "g8", piece: "N", color: "b" },
  { sq: "c8", piece: "B", color: "b" },
  { sq: "f8", piece: "B", color: "b" },
];

export function parseBoard(fen: string): Map<string, string> {
  const placement = fen.split(" ")[0];
  const map = new Map<string, string>();
  const rows = placement.split("/");
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        map.set(`${"abcdefgh"[file]}${rank}`, ch);
        file++;
      }
    }
  }
  return map;
}

// Stockfish-style phase: N/B=1, R=2, Q=4, both sides. Full board = 24.
export function taperPhase(fen: string): number {
  const board = parseBoard(fen);
  let n = 0;
  let b = 0;
  let r = 0;
  let q = 0;
  for (const pc of board.values()) {
    const lower = pc.toLowerCase();
    if (lower === "n") n++;
    else if (lower === "b") b++;
    else if (lower === "r") r++;
    else if (lower === "q") q++;
  }
  return n + b + r * 2 + q * 4;
}

export function queensOff(fen: string): boolean {
  const board = parseBoard(fen);
  for (const pc of board.values()) {
    if (pc === "Q" || pc === "q") return false;
  }
  return true;
}

// 0..10: minors off start (0..8) + king moved/castled (0..2).
export function developmentScore(fen: string): number {
  const board = parseBoard(fen);
  let score = 0;
  for (const s of START_SQUARES) {
    const pc = board.get(s.sq);
    const expected = s.color === "w" ? s.piece : s.piece.toLowerCase();
    if (pc !== expected) score++;
  }
  if (board.get("e1") !== "K") score++;
  if (board.get("e8") !== "k") score++;
  return score;
}

export type PhaseBounds = {
  totalMoveNos: number;
  oEnd: number;
  mEnd: number;
  bookMoves: number;
  devEndMove: number;
  endStartMove: number | null;
  endPhaseAtStart: number | null;
};

const DEV_THRESHOLD = 6;

function fenAtMoveEnd(moves: PhaseMove[], moveNo: number, totalMoves: number): string | null {
  if (totalMoves === 0) return null;
  const ply = Math.min(totalMoves, moveNo * 2);
  if (ply <= 0) return null;
  return moves[ply - 1]?.fen ?? null;
}

export function computePhases(moves: PhaseMove[], bookPly: number): PhaseBounds {
  const totalMoves = moves.length;
  const totalMoveNos = Math.max(1, Math.ceil(totalMoves / 2));
  const bookMoves = Math.max(0, Math.ceil((bookPly ?? 0) / 2));

  // Opening end by development: first move where both sides are
  // mostly developed. Never before book ends.
  let devEndMove = totalMoveNos;
  for (let m = 1; m <= totalMoveNos; m++) {
    const fen = fenAtMoveEnd(moves, m, totalMoves);
    if (!fen) continue;
    if (developmentScore(fen) >= DEV_THRESHOLD) {
      devEndMove = m;
      break;
    }
  }
  const oEnd = Math.max(1, Math.min(totalMoveNos, Math.max(bookMoves, devEndMove)));

  // Endgame start: first move after the opening whose position matches a
  // real endgame family. The Tapered-Eval phase backs it; the family decides.
  let endStartMove: number | null = null;
  let endPhaseAtStart: number | null = null;
  for (let m = oEnd + 1; m <= totalMoveNos; m++) {
    const fen = fenAtMoveEnd(moves, m, totalMoves);
    if (!fen) continue;
    if (endgameFamily(fen) === null) continue;
    endStartMove = m;
    endPhaseAtStart = taperPhase(fen);
    break;
  }
  const mEnd = endStartMove === null ? totalMoveNos : endStartMove - 1;

  return { totalMoveNos, oEnd, mEnd, bookMoves, devEndMove, endStartMove, endPhaseAtStart };
}

// ---- Endgame tab helpers (all real board math, no mocks) ----

export type SideCensus = { q: number; r: number; b: number; n: number; p: number };

export type Census = { w: SideCensus; b: SideCensus };

export function census(fen: string): Census {
  const board = parseBoard(fen);
  const c: Census = {
    w: { q: 0, r: 0, b: 0, n: 0, p: 0 },
    b: { q: 0, r: 0, b: 0, n: 0, p: 0 },
  };
  for (const pc of board.values()) {
    const side = pc === pc.toUpperCase() ? c.w : c.b;
    const lower = pc.toLowerCase();
    if (lower === "q") side.q++;
    else if (lower === "r") side.r++;
    else if (lower === "b") side.b++;
    else if (lower === "n") side.n++;
    else if (lower === "p") side.p++;
  }
  return c;
}

// Material difference in pawns, White minus Black.
export function materialPawnDiff(fen: string): number {
  const c = census(fen);
  const score = (s: SideCensus) => s.p * 1 + s.n * 3 + s.b * 3 + s.r * 5 + s.q * 9;
  return score(c.w) - score(c.b);
}

// Endgame families. Only these count as an endgame — a bare material
// number alone can't tell a queenless middlegame from a real ending.
export type EndgameFamily = "pawn" | "rook" | "queen" | "minor";

export function endgameFamily(fen: string): EndgameFamily | null {
  const c = census(fen);
  const wMin = c.w.b + c.w.n;
  const bMin = c.b.b + c.b.n;
  const minors = wMin + bMin;
  const rooks = c.w.r + c.b.r;
  const queens = c.w.q + c.b.q;
  const wPc = wMin + c.w.r + c.w.q;
  const bPc = bMin + c.b.r + c.b.q;
  // Pawn endgame: kings + pawns only.
  if (wPc === 0 && bPc === 0) return "pawn";
  // Rook endgame: no queens, at most one rook each, at most two minors total.
  if (queens === 0 && c.w.r <= 1 && c.b.r <= 1 && rooks >= 1 && minors <= 2) return "rook";
  // Queen endgame: at least one queen left, tiny remainder behind it.
  if (queens >= 1 && minors + rooks <= 2 && rooks <= 1) return "queen";
  // Minor-piece endgame: no queens/rooks, a few minors.
  if (queens === 0 && rooks === 0 && minors >= 1 && minors <= 3) return "minor";
  return null;
}

// e.g. "Rook + pawn endgame", "Queen + Bishop endgame". Returns null when
// the position is no recognized endgame — that null IS the gate.
export function endgameTypeLabel(fen: string): { type: string; complexity: string } | null {
  const fam = endgameFamily(fen);
  if (fam === null) return null;
  const c = census(fen);
  const pieces = c.w.q + c.w.r + c.w.b + c.w.n + c.b.q + c.b.r + c.b.b + c.b.n;
  const complexity = pieces > 4 ? "Complex endgame" : "Technical endgame";
  if (fam === "pawn") return { type: "Pawn endgame", complexity };
  // Name any minor pieces present (never pawn counts — the board shows those).
  const kinds: string[] = [];
  const knights = c.w.n + c.b.n;
  const bishops = c.w.b + c.b.b;
  if (knights > 0) kinds.push(knights > 1 ? "Knights" : "Knight");
  if (bishops > 0) kinds.push(bishops > 1 ? "Bishops" : "Bishop");
  const minorSuffix = kinds.length === 0 ? "pawn" : kinds.join(" + ");
  if (fam === "rook") return { type: `Rook + ${minorSuffix} endgame`, complexity };
  if (fam === "queen") return { type: `Queen + ${minorSuffix} endgame`, complexity };
  // Minor-piece family: single type keeps its name, mixed stays generic.
  const only = kinds.length === 1 ? kinds[0].replace(/s$/, "") : null;
  return { type: only ? `${only} endgame` : "Minor-piece endgame", complexity };
}

export function kingSquare(fen: string, color: "w" | "b"): string | null {
  const board = parseBoard(fen);
  const want = color === "w" ? "K" : "k";
  for (const [sq, pc] of board) {
    if (pc === want) return sq;
  }
  return null;
}

// Chebyshev distance of a square to the central 4 (d4/e4/d5/e5). 0 = central.
export function kingCentralDistance(sq: string | null): number {
  if (!sq) return 7;
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]) - 1;
  let best = 7;
  for (const cf of [3, 4]) {
    for (const cr of [3, 4]) {
      best = Math.min(best, Math.max(Math.abs(f - cf), Math.abs(r - cr)));
    }
  }
  return best;
}

export type PawnHealth = { doubled: number; isolated: number; passed: number };

function pawnFiles(fen: string, color: "w" | "b"): Map<number, number[]> {
  const board = parseBoard(fen);
  const want = color === "w" ? "P" : "p";
  const files = new Map<number, number[]>();
  for (const [sq, pc] of board) {
    if (pc !== want) continue;
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]);
    if (!files.has(f)) files.set(f, []);
    files.get(f)!.push(r);
  }
  return files;
}

export function pawnHealth(fen: string, color: "w" | "b"): PawnHealth {
  const own = pawnFiles(fen, color);
  const foe = pawnFiles(fen, color === "w" ? "b" : "w");
  let doubled = 0;
  let isolated = 0;
  let passed = 0;
  for (const [f, ranks] of own) {
    if (ranks.length > 1) doubled += ranks.length - 1;
    if (!own.has(f - 1) && !own.has(f + 1)) isolated += ranks.length;
    for (const r of ranks) {
      let blocked = false;
      for (let af = f - 1; af <= f + 1; af++) {
        const fr = foe.get(af);
        if (!fr) continue;
        if (color === "w" ? fr.some((x) => x > r) : fr.some((x) => x < r)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) passed++;
    }
  }
  return { doubled, isolated, passed };
}

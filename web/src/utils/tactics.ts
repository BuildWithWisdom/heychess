// Real tactic classification from board geometry + material change.
// No mocks: every label is derived from fenBefore/fenAfter + SAN + eval.
// Heuristic priority: Double check > Sacrifice > Fork > Discovered attack
// > Pin > Skewer > Deflection > Other.

import { Chess } from "chess.js";
import { parseBoard } from "./phases";

export type TacticType =
  | "Fork"
  | "Pin"
  | "Skewer"
  | "Discovered attack"
  | "Sacrifice"
  | "Double check"
  | "Deflection"
  | "Other";

export const TACTIC_ORDER: TacticType[] = [
  "Fork",
  "Pin",
  "Skewer",
  "Discovered attack",
  "Sacrifice",
  "Double check",
  "Deflection",
  "Other",
];
// Keep design order: Fork, Pin, Skewer, Discovered attack, Sacrifice,
// Double check, Deflection, Other.
export const TACTIC_LEGEND: TacticType[] = [
  "Fork",
  "Pin",
  "Skewer",
  "Discovered attack",
  "Sacrifice",
  "Double check",
  "Deflection",
  "Other",
];

type Coord = { f: number; r: number };

function sqToCoord(sq: string): Coord {
  return { f: sq.charCodeAt(0) - 97, r: Number(sq[1]) - 1 };
}

function coordToSq(f: number, r: number): string | null {
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return `${"abcdefgh"[f]}${r + 1}`;
}

function pieceAt(board: Map<string, string>, sq: string): string | undefined {
  return board.get(sq);
}

function isWhitePiece(pc: string): boolean {
  return pc === pc.toUpperCase();
}

function pieceColor(pc: string): "w" | "b" {
  return isWhitePiece(pc) ? "w" : "b";
}

// Squares a piece on `from` attacks (captures), ignoring pins/checks.
function attacksFrom(from: string, pc: string, board: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const { f, r } = sqToCoord(from);
  const lower = pc.toLowerCase();
  const own: "w" | "b" = pieceColor(pc);

  const addSlide = (dirs: [number, number][]) => {
    for (const [df, dr] of dirs) {
      let nf = f + df;
      let nr = r + dr;
      while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
        const sq = coordToSq(nf, nr)!;
        const occ = board.get(sq);
        if (!occ) {
          out.add(sq);
        } else {
          if (pieceColor(occ) !== own) out.add(sq);
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  };

  if (lower === "n") {
    for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as [number, number][]) {
      const sq = coordToSq(f + df, r + dr);
      if (!sq) continue;
      const occ = board.get(sq);
      if (!occ || pieceColor(occ) !== own) out.add(sq);
    }
  } else if (lower === "p") {
    const dir = own === "w" ? 1 : -1;
    for (const df of [-1, 1]) {
      const sq = coordToSq(f + df, r + dir);
      if (sq) out.add(sq);
    }
  } else if (lower === "k") {
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const sq = coordToSq(f + df, r + dr);
        if (!sq) continue;
        const occ = board.get(sq);
        if (!occ || pieceColor(occ) !== own) out.add(sq);
      }
    }
  } else if (lower === "b") {
    addSlide([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
  } else if (lower === "r") {
    addSlide([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  } else if (lower === "q") {
    addSlide([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);
  }
  return out;
}

function findKing(board: Map<string, string>, color: "w" | "b"): string | null {
  const want = color === "w" ? "K" : "k";
  for (const [sq, pc] of board) {
    if (pc === want) return sq;
  }
  return null;
}

// How many of `byColor`'s pieces attack `sq`?
function countAttackers(board: Map<string, string>, sq: string, byColor: "w" | "b"): number {
  let n = 0;
  for (const [from, pc] of board) {
    if (pieceColor(pc) !== byColor) continue;
    if (attacksFrom(from, pc, board).has(sq)) n++;
  }
  return n;
}

function valuableValue(pc: string): number {
  const l = pc.toLowerCase();
  if (l === "q") return 9;
  if (l === "r") return 5;
  if (l === "b" || l === "n") return 3;
  if (l === "p") return 1;
  return 0;
}

// Ray from `from` through `through`. Returns squares beyond `through`.
function rayBeyond(from: string, through: string): string[] {
  const a = sqToCoord(from);
  const b = sqToCoord(through);
  const df = Math.sign(b.f - a.f);
  const dr = Math.sign(b.r - a.r);
  if (df === 0 && dr === 0) return [];
  // Must be straight or diagonal.
  if (df !== 0 && dr !== 0 && Math.abs(b.f - a.f) !== Math.abs(b.r - a.r)) return [];
  const out: string[] = [];
  let nf = b.f + df;
  let nr = b.r + dr;
  while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
    out.push(coordToSq(nf, nr)!);
    nf += df;
    nr += dr;
  }
  return out;
}

// After `mover` moves, does one of their sliders line up with the enemy king
// with exactly one enemy piece between? -> absolute pin created.
function createsPin(boardAfter: Map<string, string>, mover: "w" | "b"): boolean {
  const enemyKing = findKing(boardAfter, mover === "w" ? "b" : "w");
  if (!enemyKing) return false;
  for (const [from, pc] of boardAfter) {
    if (pieceColor(pc) !== mover) continue;
    const l = pc.toLowerCase();
    if (l !== "b" && l !== "r" && l !== "q") continue;
    const atk = attacksFrom(from, pc, boardAfter);
    if (!atk.has(enemyKing)) continue;
    // Walk from slider to king, count enemy pieces in between.
    const a = sqToCoord(from);
    const b = sqToCoord(enemyKing);
    const df = Math.sign(b.f - a.f);
    const dr = Math.sign(b.r - a.r);
    let nf = a.f + df;
    let nr = a.r + dr;
    let between: string[] = [];
    while (nf !== b.f || nr !== b.r) {
      const sq = coordToSq(nf, nr)!;
      const occ = boardAfter.get(sq);
      if (occ) between.push(sq);
      nf += df;
      nr += dr;
    }
    if (between.length === 1 && pieceColor(boardAfter.get(between[0])!) !== mover) return true;
  }
  return false;
}

// Skewer: own slider hits a valuable enemy piece with the enemy king (or a
// second enemy piece) directly behind it on the same ray.
function createsSkewer(boardAfter: Map<string, string>, mover: "w" | "b"): boolean {
  const enemy: "w" | "b" = mover === "w" ? "b" : "w";
  for (const [from, pc] of boardAfter) {
    if (pieceColor(pc) !== mover) continue;
    const l = pc.toLowerCase();
    if (l !== "b" && l !== "r" && l !== "q") continue;
    const atk = attacksFrom(from, pc, boardAfter);
    for (const target of atk) {
      const targetPc = boardAfter.get(target);
      if (!targetPc || pieceColor(targetPc) !== enemy) continue;
      if (valuableValue(targetPc) < 3) continue;
      // Is there another enemy piece (or king) directly behind target?
      const beyond = rayBeyond(from, target);
      for (const sq of beyond) {
        const occ = boardAfter.get(sq);
        if (!occ) continue;
        if (pieceColor(occ) === enemy) return true;
        break;
      }
    }
  }
  return false;
}

// Discovered attack: the moved piece vacated a line so a friendly slider now
// attacks a valuable enemy target (or gives check).
function createsDiscovered(
  boardBefore: Map<string, string>,
  boardAfter: Map<string, string>,
  mover: "w" | "b",
  fromSq: string
): boolean {
  // Only non-sliders can uncover (knight/pawn/king).
  const movedBefore = boardBefore.get(fromSq);
  if (!movedBefore) return false;
  const l = movedBefore.toLowerCase();
  if (l === "b" || l === "r" || l === "q") return false;
  const enemy: "w" | "b" = mover === "w" ? "b" : "w";
  const enemyKing = findKing(boardAfter, enemy);
  for (const [from, pc] of boardAfter) {
    if (pieceColor(pc) !== mover) continue;
    const pl = pc.toLowerCase();
    if (pl !== "b" && pl !== "r" && pl !== "q") continue;
    // Slider must sit on the vacated line: fromSq lies on ray from slider.
    const a = sqToCoord(from);
    const v = sqToCoord(fromSq);
    const df = Math.sign(v.f - a.f);
    const dr = Math.sign(v.r - a.r);
    if (df === 0 && dr === 0) continue;
    if (df !== 0 && dr !== 0 && Math.abs(v.f - a.f) !== Math.abs(v.r - a.r)) continue;
    // Path slider -> fromSq must be clear in the AFTER position (it is, the
    // piece left), and was blocked before.
    const atk = attacksFrom(from, pc, boardAfter);
    // Gives check via discovery?
    if (enemyKing && atk.has(enemyKing)) {
      // Was it already check before? Compare.
      const atkBefore = attacksFrom(from, pc, boardBefore);
      // In before-board the slider is blocked by the moved piece; rough check:
      // if the slider didn't attack the king square before, it's discovered.
      const kingSqBefore = findKing(boardBefore, enemy);
      if (kingSqBefore && !atkBefore.has(kingSqBefore)) return true;
    }
    for (const t of atk) {
      const tp = boardAfter.get(t);
      if (!tp || pieceColor(tp) !== enemy) continue;
      if (valuableValue(tp) < 3 && t !== enemyKing) continue;
      return true;
    }
  }
  return false;
}

export type TacticEvidence = {
  type: TacticType;
  from: string | null;
  to: string | null;
  mover: "w" | "b";
};

export function classifyTactic(opts: {
  fenBefore: string;
  fenAfter: string;
  san: string;
  mover: "w" | "b";
  moverMaterialDiff: number; // mover perspective, centipawns (negative = gave material)
  keepEvalCp: number; // mover-perspective eval after the move
}): TacticEvidence {
  const { fenBefore, fenAfter, san, mover, moverMaterialDiff, keepEvalCp } = opts;
  let from: string | null = null;
  let to: string | null = null;
  try {
    const c = new Chess(fenBefore);
    const mv = c.move(san);
    from = mv.from;
    to = mv.to;
  } catch {
    from = null;
    to = null;
  }

  const boardAfter = parseBoard(fenAfter);
  const boardBefore = parseBoard(fenBefore);
  const enemy: "w" | "b" = mover === "w" ? "b" : "w";
  const enemyKing = findKing(boardAfter, enemy);

  // 1. Double check: enemy king attacked twice.
  if (enemyKing && countAttackers(boardAfter, enemyKing, mover) >= 2) {
    return { type: "Double check", from, to, mover };
  }

  // 2. Sacrifice: gave >= 2 pawns of material but position stays playable.
  if (moverMaterialDiff <= -200 && keepEvalCp >= -150) {
    return { type: "Sacrifice", from, to, mover };
  }

  // 3. Fork: moved piece attacks 2+ valuable enemy targets.
  if (from && to) {
    const movedPc = boardAfter.get(to);
    if (movedPc && pieceColor(movedPc) === mover) {
      const atk = attacksFrom(to, movedPc, boardAfter);
      let hits = 0;
      for (const sq of atk) {
        const tp = boardAfter.get(sq);
        if (tp && pieceColor(tp) === enemy && valuableValue(tp) >= 1) {
          // Ignore the just-captured square recapture noise: count distinct
          // enemy pieces currently attacked.
          hits++;
        }
      }
      // Knight/pawn/king forks need 2 targets; sliders need 2 valuable ones.
      const need = movedPc.toLowerCase() === "n" || movedPc.toLowerCase() === "p" ? 2 : 2;
      const valuableHits = (() => {
        let v = 0;
        for (const sq of atk) {
          const tp = boardAfter.get(sq);
          if (tp && pieceColor(tp) === enemy && valuableValue(tp) >= 3) v++;
        }
        return v;
      })();
      if (hits >= need && (valuableHits >= 1 || hits >= 2)) {
        // Avoid flagging every developing knight move: require at least one
        // non-pawn target or a check.
        const nonPawn = (() => {
          for (const sq of atk) {
            const tp = boardAfter.get(sq);
            if (tp && pieceColor(tp) === enemy && valuableValue(tp) >= 3) return true;
          }
          return false;
        })();
        const givesCheck = enemyKing !== null && atk.has(enemyKing);
        if (nonPawn || givesCheck) return { type: "Fork", from, to, mover };
      }
    }
  }

  // 4. Discovered attack.
  if (from && createsDiscovered(boardBefore, boardAfter, mover, from)) {
    return { type: "Discovered attack", from, to, mover };
  }

  // 5. Pin.
  if (createsPin(boardAfter, mover)) {
    return { type: "Pin", from, to, mover };
  }

  // 6. Skewer.
  if (createsSkewer(boardAfter, mover)) {
    return { type: "Skewer", from, to, mover };
  }

  // 7. Deflection: capture of a pawn-valued-or-better defender that was
  // shielding a high-value target (approx: capture + opponent had 2+
  // attackers on the captured square region). Keep conservative.
  if (san.includes("x")) {
    const capturedValuable = moverMaterialDiff >= 100;
    if (capturedValuable && enemyKing && countAttackers(boardBefore, to ?? "", enemy) >= 1) {
      return { type: "Deflection", from, to, mover };
    }
  }

  void pieceAt;
  return { type: "Other", from, to, mover };
}

// Material (mover perspective) helper shared with the tab.
const VALS: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

export function materialScoreFen(fen: string): { w: number; b: number } {
  const placement = fen.split(" ")[0];
  let w = 0;
  let b = 0;
  for (const ch of placement) {
    if (ch === "/" || /\d/.test(ch)) continue;
    const v = VALS[ch.toLowerCase()] ?? 0;
    if (ch === ch.toLowerCase()) b += v;
    else w += v;
  }
  return { w, b };
}

export function moverMaterialDiffCp(fenBefore: string, fenAfter: string, mover: "w" | "b"): number {
  const a = materialScoreFen(fenBefore);
  const c = materialScoreFen(fenAfter);
  const diffW = c.w - a.w - (c.b - a.b);
  const diffB = c.b - a.b - (c.w - a.w);
  return mover === "w" ? diffW : diffB;
}

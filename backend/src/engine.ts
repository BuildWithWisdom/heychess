import { spawn } from "node:child_process";
import { Chess } from "chess.js";
import type { MoveEval, MoveVerdict } from "@heychess/contracts";

const BIN = new URL("../bin/stockfish/stockfish-ubuntu-x86-64", import.meta.url).pathname;

type EvalResult = { cp: number; bestUci: string | null };

function parseScore(line: string): number | null {
  // info depth 12 score cp 34 ...  OR  score mate 3
  const m = line.match(/score (cp|mate) (-?\d+)/);
  if (!m) return null;
  if (m[1] === "cp") return Number(m[2]);
  const mate = Number(m[2]);
  return mate > 0 ? 100000 - mate : -100000 - mate;
}

async function searchPositions(fens: string[], depth: number): Promise<EvalResult[]> {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "ignore"] });
  const out: EvalResult[] = fens.map(() => ({ cp: 0, bestUci: null }));
  let buf = "";
  let idx = 0;
  let lastScore: number | null = null;

  const write = (s: string) =>
    new Promise<void>((resolve, reject) => {
      proc.stdin.write(s + "\n", (err) => (err ? reject(err) : resolve()));
    });

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("info ") && line.includes("score ")) {
          const cp = parseScore(line);
          if (cp !== null) lastScore = cp;
        } else if (line.startsWith("bestmove")) {
          const parts = line.split(" ");
          // Stockfish scores are relative to side to move; normalize to White perspective.
          const stm = fens[idx].split(" ")[1] === "b" ? -1 : 1;
          out[idx] = { cp: (lastScore ?? 0) * stm, bestUci: parts[1] && parts[1] !== "(none)" ? parts[1] : null };
          idx++;
          lastScore = null;
          if (idx < fens.length) {
            void sendNext();
          } else {
            void write("quit").then(() => resolve());
          }
        }
      }
    });
  });

  async function sendNext() {
    await write("ucinewgame");
    await write(`position fen ${fens[idx]}`);
    await write(`go depth ${depth}`);
  }

  await write("uci");
  await new Promise((r) => setTimeout(r, 300));
  await sendNext();
  await done;
  return out;
}

const PIECE_VALS: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function materialScore(fen: string): { w: number; b: number } {
  const board = fen.split(" ")[0];
  let w = 0;
  let b = 0;
  for (const ch of board) {
    if (ch === "/") continue;
    if (/\d/.test(ch)) continue;
    const lower = ch.toLowerCase();
    const v = PIECE_VALS[lower] ?? 0;
    if (ch === lower) b += v;
    else w += v;
  }
  return { w, b };
}

function classify(lossCp: number, opts?: { sacrifice?: boolean; winMaterial?: boolean; mates?: boolean; keepEvalCp?: number }): MoveVerdict {
  if (lossCp <= 5) {
    // Stockfish only gives cp + bestmove. Brilliant/Great are our labels:
    // brilliant = best move that gives net material (>=2 pawns) but keeps the
    // position playable. Great = best move that wins net material or mates.
    // Quiet best moves stay "best". Net-material misses hanging-piece sacs
    // (piece still on board until captured) — those stay best/great for now.
    if (opts?.sacrifice && (opts.keepEvalCp ?? 0) >= -50) return "brilliant";
    if (opts?.mates || opts?.winMaterial) return "great";
    return "best";
  }
  if (lossCp < 30) return "good";
  if (lossCp < 80) return "inaccuracy";
  if (lossCp < 180) return "mistake";
  return "blunder";
}

function uciToSan(fen: string, uci: string | null): string | undefined {
  if (!uci) return undefined;
  try {
    const c = new Chess(fen);
    const move = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move.san;
  } catch {
    return undefined;
  }
}

function parsePgnSide(pgn: string, username?: string): "w" | "b" | null {
  if (!username) return null;
  const lower = username.toLowerCase();
  const w = pgn.match(/\[White\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
  const b = pgn.match(/\[Black\s+"([^"]+)"\]/)?.[1]?.toLowerCase();
  if (w === lower) return "w";
  if (b === lower) return "b";
  return null;
}

export async function analyzePgn(
  pgn: string,
  depth = 12,
  username?: string
): Promise<{ evals: MoveEval[]; accuracy: number; userColor: "w" | "b" | null }> {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const sans: string[] = chess.history();
  const replay = new Chess();
  const fens: string[] = [replay.fen()];
  for (const san of sans) {
    replay.move(san);
    fens.push(replay.fen());
  }

  const searched = await searchPositions(fens, Math.min(Math.max(depth, 8), 16));

  const evals: MoveEval[] = [];
  const userColor = parsePgnSide(pgn, username);
  let totalLoss = 0;
  let counted = 0;
  // Mate scores (±100000) would nuke the mean: cap per-move loss for accuracy.
  // Verdicts still use the raw loss, so blunders stay blunders.
  const ACC_LOSS_CAP = 300;
  const probe = new Chess();
  for (let i = 0; i < sans.length; i++) {
    const before = searched[i];
    const after = searched[i + 1];
    const isWhite = i % 2 === 0;
    const bestMover = isWhite ? before.cp : -before.cp;
    const actualMover = isWhite ? after.cp : -after.cp;
    const loss = Math.max(0, bestMover - actualMover);
    const isUserMove = userColor === null || (userColor === "w") === isWhite;
    if (isUserMove) {
      totalLoss += Math.min(loss, ACC_LOSS_CAP);
      counted++;
    }
    const matBefore = materialScore(fens[i]);
    const matAfter = materialScore(fens[i + 1]);
    // Net material from the mover's perspective (captures minus losses).
    const moverDiff = isWhite
      ? matAfter.w - matBefore.w - (matAfter.b - matBefore.b)
      : matAfter.b - matBefore.b - (matAfter.w - matBefore.w);
    const sacrifice = moverDiff <= -200;
    const winMaterial = moverDiff >= 200;
    const mates = actualMover >= 90000;
    evals.push({
      ply: i + 1,
      san: sans[i],
      evalCp: after.cp,
      deltaCp: Math.round(loss),
      verdict: classify(loss, { sacrifice, winMaterial, mates, keepEvalCp: actualMover }),
      bestSan: uciToSan(fens[i], before.bestUci),
    });
    probe.move(sans[i]);
  }

  const avgLoss = counted ? totalLoss / counted : 0;
  const accuracy = Math.max(0, Math.min(100, Math.round(100 - avgLoss / 3)));
  return { evals, accuracy, userColor };
}

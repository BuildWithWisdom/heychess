import type { MoveEval } from "@heychess/contracts";

// Mirrors backend/src/engine.ts. Frontend phase/stats accuracies must use the
// same Win% model or the list, summary, and stats cards will disagree.
export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function moveAccuracy(actualMoverCp: number, lossCp: number): number {
  const best = actualMoverCp + Math.max(0, lossCp);
  const wb = winPercent(best);
  const wa = winPercent(actualMoverCp);
  if (wa >= wb) return 100;
  const raw = 103.1668 * Math.exp(-0.04354 * (wb - wa)) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

function moverCp(e: MoveEval): number {
  const whiteMove = e.ply % 2 === 1;
  return whiteMove ? e.evalCp : -e.evalCp;
}

export function gameAccuracyFromEvals(evals: MoveEval[]): number | null {
  if (evals.length === 0) return null;
  const accs = evals.map((e) => moveAccuracy(moverCp(e), e.deltaCp ?? 0));
  const arith = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harm = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 0.1), 0);
  return Math.max(0, Math.min(100, Math.round((arith + harm) / 2)));
}

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { Game, GameAnalysis, GameDetail as Detail, MoveEval } from "@heychess/contracts";
import { computePhases, endgameTypeLabel, kingCentralDistance, kingSquare, materialPawnDiff, pawnHealth } from "../utils/phases";
import { classifyTactic, moverMaterialDiffCp, TACTIC_LEGEND, type TacticType } from "../utils/tactics";
import "./GameDetail.css";

const API = "http://localhost:3001";
const QUICK_DEPTH = 10;
const DEEP_DEPTH = 16;
// Safety cap per coach call; engine notes cover the rest regardless.
const MAX_CANDIDATES = 12;

// Name plate shown above/below every board so each side is identified.
function PlayerBar({ name, color }: { name: string; color: "w" | "b" }) {
  return (
    <div className="player-bar">
      <span className={`player-dot ${color}`}>{name.charAt(0).toUpperCase()}</span>
      <span className="player-name">{name}</span>
    </div>
  );
}

export default function GameDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const stateGame = (location.state as { game?: Game } | null)?.game ?? null;

  const [game, setGame] = useState<Game | null>(stateGame);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [explanations, setExplanations] = useState<Record<number, string>>({});
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState("");
  const [ply, setPly] = useState(0);
  const [error, setError] = useState("");
  const [takeaways, setTakeaways] = useState<string[]>([]);
  const [depthUsed, setDepthUsed] = useState<number | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  // User took manual control of the board: stop autoplay AND don't yank the
  // board to the worst move when analysis lands.
  const tookOver = useRef(false);
  const stopAuto = () => {
    setAutoPlay(false);
    tookOver.current = true;
  };
  const explainedFor = useRef<string | null>(null);
  const [tab, setTab] = useState<"analysis" | "summary" | "stats" | "opening" | "middlegame" | "endgame" | "tactics">("analysis");
  // Opening-tab local UI: board cursor inside the opening + full key-move list.
  const [opPly, setOpPly] = useState<number | null>(null);
  const [showAllKeyMoves, setShowAllKeyMoves] = useState(false);
  // Middlegame-tab local UI: board cursor clamped inside the middlegame range.
  const [midPly, setMidPly] = useState<number | null>(null);
  // Endgame-tab local UI: board cursor clamped inside the endgame range.
  const [endPly, setEndPly] = useState<number | null>(null);
  // Tactics-tab local UI: inline position preview per row (design has no
  // permanent board — "View position" expands the row's board).
  const [tacViewPly, setTacViewPly] = useState<number | null>(null);
  const [showAllTac, setShowAllTac] = useState(false);
  // Practice board state for the expanded tactic: null = game position,
  // otherwise the user's live line. Before/after toggle + flip like other tabs.
  const [tacPracticeFen, setTacPracticeFen] = useState<string | null>(null);
  const [tacPracticeMsg, setTacPracticeMsg] = useState("");
  const [tacBefore, setTacBefore] = useState(false);
  const [tacFlip, setTacFlip] = useState(false);
  function openTacPreview(ply: number) {
    setTacViewPly((v) => {
      const next = v === ply ? null : ply;
      // Fresh board every time a row opens.
      setTacPracticeFen(null);
      setTacPracticeMsg("");
      setTacBefore(false);
      return next;
    });
  }

  // ONE coach call per analysis run. Engine + LLM resolve before anything
  // renders, so verdicts and commentary appear together — never staged.
  async function runCoaching(g: Game, data: Detail, depth: number) {
    const key = `${g.id}:${depth}`;
    if (explainedFor.current === key) return;
    explainedFor.current = key;
    setAnalyzing(true);
    setExplaining(false);
    setExplainError("");
    setDepthUsed(depth);
    try {
      const ar = await fetch(`${API}/api/games/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: g.pgn, depth, username: "aguowisdom" }),
      });
      const aj: GameAnalysis = await ar.json();
      if (!ar.ok) throw new Error((aj as unknown as { error?: string }).error ?? "analysis failed");

      // No teleports: the board stays where autoplay or the user left it.
      // The timeline dots carry the verdict colors; the user drives.

      // Whole-game coverage (chess.com style): notable moves for BOTH sides,
      // plus genuinely strong moves per side (best verdict + eval swing).
      const isUserPly = (ply: number) =>
        !aj.userColor || (aj.userColor === "w") === (ply % 2 === 1);
      const allBad = aj.evals
        .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
        .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0));
      const evalAfter = (ply: number) => aj.evals[ply - 1]?.evalCp ?? 0;
      const evalBefore = (ply: number) => (ply <= 1 ? 25 : (aj.evals[ply - 2]?.evalCp ?? 25));
      const moverSwing = (ply: number) => {
        const white = ply % 2 === 1;
        const after = white ? evalAfter(ply) : -evalAfter(ply);
        const before = white ? evalBefore(ply) : -evalBefore(ply);
        return after - before;
      };
      const impressiveFor = (userSide: boolean) =>
        aj.evals
          .filter((e) => e.verdict === "best" && isUserPly(e.ply) === userSide && moverSwing(e.ply) >= 50)
          .sort((a, b) => moverSwing(b.ply) - moverSwing(a.ply))
          .slice(0, 2);
      const notable = [...allBad, ...impressiveFor(true), ...impressiveFor(false)]
        .sort((a, b) => a.ply - b.ply)
        .slice(0, MAX_CANDIDATES);

      // PGN-style context grounds the coach in the real game line (FEN
      // strings made it hallucinate pieces/squares).
      const pairMap = new Map<number, { w?: string; b?: string }>();
      for (const m of data.moves) {
        const p = pairMap.get(m.moveNo) ?? {};
        if (m.color === "w") p.w = m.san;
        else p.b = m.san;
        pairMap.set(m.moveNo, p);
      }
      const gameLine = [...pairMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, p]) => `${n}. ${p.w ?? ""}${p.b ? ` ${p.b}` : ""}`.trim())
        .join(" ");

      let notes: Record<number, string> = {};
      if (notable.length > 0) {
        setExplaining(true);
        try {
          const er = await fetch(`${API}/api/analyze/explain-game`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              moves: notable.map((e) => ({
                moveNo: Math.floor((e.ply - 1) / 2) + 1,
                ply: e.ply,
                san: e.san,
                bestSan: e.bestSan,
                deltaCp: e.deltaCp ?? 0,
                verdict: e.verdict,
              })),
              gameLine,
              userColor: aj.userColor,
              accuracy: aj.accuracy,
              result: g.result,
              opponent: g.opponent,
            }),
          });
          const ej = await er.json();
          if (!er.ok) throw new Error(ej.error ?? "explain failed");
          notes = ej.notes ?? {};
          setTakeaways(Array.isArray(ej.takeaways) ? ej.takeaways.map(String) : []);
        } finally {
          setExplaining(false);
        }
      }
      // Reveal together: verdicts + commentary land in the same paint.
      setAnalysis(aj);
      setExplanations(notes);
      setDepthUsed(depth);
      setAutoPlay(false);
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : "analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function runDeep() {
    if (!game || !detail || analyzing || explaining) return;
    explainedFor.current = null;
    tookOver.current = false;
    setAnalysis(null);
    await runCoaching(game, detail, DEEP_DEPTH);
  }

  useEffect(() => {
    async function run() {
      try {
        let g = stateGame;
        if (!g) {
          const list = await (await fetch(`${API}/api/games?username=aguowisdom&limit=20`)).json();
          g = list.games.find((x: Game) => x.id === id) ?? null;
        }
        if (!g?.pgn) throw new Error("game not found");
        setGame(g);
        const res = await fetch(`${API}/api/games/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pgn: g.pgn }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "parse failed");
        setDetail(data);
        // Start at move 1 and autoplay through the game while engine+coach
        // work in the background — no frozen empty board.
        setPly(0);
        setAutoPlay(true);
        tookOver.current = false;
        // Quick analysis auto-runs. Deep analysis is user-triggered.
        await runCoaching(g, data, QUICK_DEPTH);
      } catch (e) {
        setError(e instanceof Error ? e.message : "load failed");
      }
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Autoplay the game on the board while engine+coach run in the background.
  // Any manual navigation stops it; analysis reveal jumps to the worst move.
  useEffect(() => {
    if (!detail || !autoPlay) return;
    if (analysis) return;
    if (!analyzing && !explaining) return;
    if (ply >= detail.moves.length) return;
    const t = setInterval(() => {
      setPly((p) => Math.min(detail.moves.length, p + 1));
    }, 900);
    return () => clearInterval(t);
  }, [detail, autoPlay, analysis, analyzing, explaining, ply]);

  const totalMoves = detail?.moves.length ?? 0;
  // Real chess phases (book + development for Opening, tapered material
  // for Endgame). Short mates stay all-Opening; Mid/End can be empty.
  const phaseBounds = useMemo(
    () => computePhases(detail?.moves ?? [], detail?.opening?.bookPly ?? 0),
    [detail]
  );
  const oEnd = phaseBounds.oEnd;
  const mEnd = phaseBounds.mEnd;
  const totalMoveNos = phaseBounds.totalMoveNos;

  const rows = useMemo(() => {
    if (!detail) return [];
    const out: { moveNo: number; w?: string; wPly?: number; b?: string; bPly?: number }[] = [];
    for (const m of detail.moves) {
      let r = out.find((x) => x.moveNo === m.moveNo);
      if (!r) {
        r = { moveNo: m.moveNo };
        out.push(r);
      }
      if (m.color === "w") {
        r.w = m.san;
        r.wPly = m.ply;
      } else {
        r.b = m.san;
        r.bPly = m.ply;
      }
    }
    return out;
  }, [detail]);

  const meta = game
    ? `${game.timeControl} · ${new Date(game.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${totalMoves} moves`
    : "";

  const openingEndPlyAll = Math.min(totalMoves, oEnd * 2);
  const midStartPlyAll = oEnd * 2 + 1;
  const midEndPlyAll = Math.min(totalMoves, mEnd * 2);
  const endStartPlyAll = mEnd * 2 + 1;
  const opening = detail?.moves.slice(0, openingEndPlyAll) ?? [];
  const middlegame = detail && midStartPlyAll <= midEndPlyAll
    ? detail.moves.slice(midStartPlyAll - 1, midEndPlyAll)
    : [];
  const endgame = detail && endStartPlyAll <= totalMoves
    ? detail.moves.slice(endStartPlyAll - 1)
    : [];

  const worst = analysis
    ? [...analysis.evals].sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0))[0] ?? null
    : null;
  const evalByPly = new Map((analysis?.evals ?? []).map((e) => [e.ply, e]));
  const defaultOrientation = analysis?.userColor === "b" ? "black" : "white";
  const orientation = flipped
    ? defaultOrientation === "black" ? "white" : "black"
    : defaultOrientation;
  // Player names from the PGN headers; fall back to you/opponent.
  const pgnWhite = game?.pgn?.match(/\[White\s+"([^"]+)"\]/)?.[1];
  const pgnBlack = game?.pgn?.match(/\[Black\s+"([^"]+)"\]/)?.[1];
  const whitePlayer = pgnWhite ?? (analysis?.userColor === "w" ? "You" : (game?.opponent ?? "White"));
  const blackPlayer = pgnBlack ?? (analysis?.userColor === "b" ? "You" : (game?.opponent ?? "Black"));
  const topPlayer = orientation === "white" ? blackPlayer : whitePlayer;
  const topColor = orientation === "white" ? "b" : "w";
  const bottomPlayer = orientation === "white" ? whitePlayer : blackPlayer;
  const bottomColor = orientation === "white" ? "w" : "b";
  const current = analysis?.evals.find((e) => e.ply === ply) ?? null;
  const shown = current ?? worst;
  const shownIsOpponent = !analysis?.userColor || !shown
    ? false
    : (analysis.userColor === "w") !== (shown.ply % 2 === 1);

  const fmtDelta = (cp: number) => (cp >= 90000 ? "#" : `-${(cp / 100).toFixed(1)}`);
  const fmtCp = (cp: number) => {
    if (cp >= 90000) return "#";
    if (cp <= -90000) return "-#";
    return `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(1)}`;
  };
  const moveNoOf = (ply: number) => Math.floor((ply - 1) / 2) + 1;

  // Best-move eval in White perspective, from the mover's loss.
  const bestCpWhite = (() => {
    if (!shown) return null;
    const loss = shown.deltaCp ?? 0;
    if (loss >= 90000) return null;
    const moverWhite = shown.ply % 2 === 1;
    const actualMover = moverWhite ? shown.evalCp : -shown.evalCp;
    const bestMover = actualMover + loss;
    return moverWhite ? bestMover : -bestMover;
  })();
  const bestLabel = shown?.bestSan ? `${moveNoOf(shown.ply)}. ${shown.bestSan}` : "—";
  const bestEvalLabel = bestCpWhite === null ? "#" : fmtCp(bestCpWhite);

  const isUserPlyNow = (p: number) =>
    !analysis?.userColor || (analysis.userColor === "w") === (p % 2 === 1);

  // Deterministic engine note from Stockfish numbers only — no invented
  // tactics. Guarantees EVERY move has commentary even if the coach LLM
  // fails or skips it; LLM notes override this wherever present.
  function localNote(ply: number): string | null {
    const e = evalByPly.get(ply);
    if (!e) return null;
    const moveRef = `${moveNoOf(ply)}. ${e.san}`;
    const mineNow = isUserPlyNow(ply);
    const v = e.verdict ?? "good";
    const after = fmtCp(e.evalCp);
    const before = fmtCp(ply <= 1 ? 20 : (evalByPly.get(ply - 1)?.evalCp ?? 20));
    const bestRef = e.bestSan ? `${moveNoOf(ply)}. ${e.bestSan}` : null;
    if (v === "blunder" || v === "mistake" || v === "inaccuracy") {
      const lost = ((e.deltaCp ?? 0) / 100).toFixed(1);
      return (
        `${mineNow ? "You played" : "Your opponent played"} ${moveRef} — a ${v} giving up about ${lost} pawns. ` +
        (bestRef ? `${bestRef} was the stronger try.` : "There was something stronger.") +
        `\nWhy: Eval moves from ${before} to ${after}.` +
        (bestRef ? `\nWhy: Engine prefers ${bestRef}.` : "")
      );
    }
    if (v === "best" || v === "brilliant") {
      return (
        `${moveRef} is the engine's top choice. ` +
        (mineNow ? "Well played" : "Well found by your opponent") +
        ` — the position stays around ${after}.\nWhy: Nothing dropped on this move.`
      );
    }
    return (
      `${moveRef} is solid and keeps the balance around ${after}.` +
      `\nWhy: No significant eval change (${before} to ${after}).`
    );
  }
  const shownExpl = shown ? (explanations[shown.ply] ?? localNote(shown.ply) ?? undefined) : undefined;

  // Split coach note into explanation paragraph + Why bullets.
  const { noteText, noteWhys } = (() => {
    if (!shownExpl) return { noteText: "", noteWhys: [] as string[] };
    const lines = shownExpl.split("\n").map((l) => l.trim()).filter(Boolean);
    const text: string[] = [];
    const whys: string[] = [];
    for (const l of lines) {
      if (/^why\s*:/i.test(l)) whys.push(l.replace(/^why\s*:/i, "").trim());
      else if (whys.length === 0) text.push(l);
      else whys.push(l);
    }
    return { noteText: text.join(" "), noteWhys: whys.slice(0, 3) };
  })();

  // ---- Summary tab derivations (all local Stockfish math) ----
  const evalAfterP = (p: number) => evalByPly.get(p)?.evalCp ?? 0;
  const evalBeforeP = (p: number) => (p <= 1 ? 20 : (evalByPly.get(p - 1)?.evalCp ?? 20));
  const swingP = (p: number) => {
    const w = p % 2 === 1;
    const a = w ? evalAfterP(p) : -evalAfterP(p);
    const b = w ? evalBeforeP(p) : -evalBeforeP(p);
    return a - b;
  };
  const isUserP = (p: number) =>
    !analysis?.userColor || (analysis.userColor === "w") === (p % 2 === 1);
  const userEvals = (analysis?.evals ?? []).filter((e) => isUserP(e.ply));
  const phaseAcc = (fromMove: number, toMove: number): number | null => {
    const ps = userEvals.filter((e) => {
      const m = moveNoOf(e.ply);
      return m >= fromMove && m <= toMove;
    });
    if (ps.length === 0) return null;
    const avg = ps.reduce((s, e) => s + Math.min(e.deltaCp ?? 0, 300), 0) / ps.length;
    return Math.max(0, Math.min(100, Math.round(100 - avg / 3)));
  };
  const phaseLabel = (acc: number | null): string =>
    acc === null ? "—" : acc >= 85 ? "Excellent" : acc >= 75 ? "Strong" : acc >= 60 ? "Good" : "Needs work";
  const phaseSub = (from: number, to: number): string =>
    from > to ? "(not reached)" : from === 1 ? `(1–${to} moves)` : `(${from}–${to} moves)`;
  const phases = [
    { key: "Opening", sub: phaseSub(1, oEnd), from: 1, to: oEnd, dot: "d-open" },
    { key: "Middlegame", sub: phaseSub(oEnd + 1, mEnd), from: oEnd + 1, to: mEnd, dot: "d-mid" },
    { key: "Endgame", sub: phaseSub(mEnd + 1, totalMoveNos), from: mEnd + 1, to: totalMoveNos, dot: "d-end" },
  ];
  const tierOf = (acc: number | null): string =>
    acc === null ? "weak" : acc >= 85 ? "excellent" : acc >= 75 ? "strong" : acc >= 60 ? "good" : "weak";
  const bestUserMove =
    userEvals
      .filter((e) => e.verdict === "best" || e.verdict === "brilliant" || e.verdict === "great")
      .sort((a, b) => swingP(b.ply) - swingP(a.ply))[0] ?? null;
  const biggestSlip =
    userEvals
      .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
      .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0))[0] ?? null;
  const turning: MoveEval | null = (analysis?.evals ?? []).reduce<MoveEval | null>(
    (top, e) => (!top || Math.abs(swingP(e.ply)) > Math.abs(swingP(top.ply)) ? e : top),
    null
  );
  const turningText = (() => {
    if (!turning) return "An even game throughout.";
    const goodForUser =
      (analysis?.userColor === "w" && turning.evalCp > 100) ||
      (analysis?.userColor === "b" && turning.evalCp < -100);
    if (isUserP(turning.ply)) {
      return turning.verdict === "blunder" || turning.verdict === "mistake"
        ? "You slipped — the game turned there."
        : `You seized the initiative${turning.verdict === "brilliant" ? " with a brilliant tactic" : ""}.`;
    }
    return goodForUser
      ? "Your opponent slipped and the game turned your way."
      : "Your opponent seized the initiative.";
  })();
  const bestPhase = phases
    .map((ph) => ({ ...ph, acc: phaseAcc(ph.from, ph.to) }))
    .sort((a, b) => (b.acc ?? -1) - (a.acc ?? -1))[0];
  const fbTakeaways = [
    `You finished with ${analysis?.accuracy ?? "—"}% accuracy.`,
    biggestSlip
      ? `Biggest slip: ${moveNoOf(biggestSlip.ply)}. ${biggestSlip.san} (${biggestSlip.verdict}, -${((biggestSlip.deltaCp ?? 0) / 100).toFixed(1)}).`
      : "No major slips — a clean game.",
    bestPhase && bestPhase.acc !== null
      ? `Strongest phase: ${bestPhase.key} (${bestPhase.acc}%).`
      : "Play through the timeline to review each phase.",
  ];
  const shownTakeaways = (takeaways.length > 0 ? takeaways : fbTakeaways)
    .slice(0, 3)
    .map((t) => (t.length > 90 ? `${t.slice(0, 87).trim()}…` : t));
  const resultLine =
    game?.result === "win"
      ? `You won this game in ${totalMoveNos} moves.`
      : game?.result === "loss"
        ? `You lost this game in ${totalMoveNos} moves.`
        : `You drew this game in ${totalMoveNos} moves.`;

  // ---- Stats tab derivations (all live, from analysis.evals + detail.moves) ----
  const accForColor = (color: "w" | "b"): number | null => {
    const ps = (analysis?.evals ?? []).filter((e) => (e.ply % 2 === 1) === (color === "w"));
    if (ps.length === 0) return null;
    const avg = ps.reduce((s, e) => s + Math.min(e.deltaCp ?? 0, 300), 0) / ps.length;
    return Math.max(0, Math.min(100, Math.round(100 - avg / 3)));
  };
  const accWhite = accForColor("w");
  const accBlack = accForColor("b");
  const qualityOrder = ["brilliant", "great", "best", "good", "inaccuracy", "mistake", "blunder"] as const;
  const qualityCounts = (() => {
    const m = new Map<string, number>();
    for (const e of userEvals) m.set(e.verdict ?? "good", (m.get(e.verdict ?? "good") ?? 0) + 1);
    return qualityOrder.map((v) => ({ verdict: v, count: m.get(v) ?? 0 }));
  })();
  const maxQuality = Math.max(1, ...qualityCounts.map((q) => q.count));
  const avgCpl =
    userEvals.length === 0
      ? null
      : Math.round(userEvals.reduce((s, e) => s + Math.min(e.deltaCp ?? 0, 1000), 0) / userEvals.length);
  const mistakeCount = userEvals.filter((e) => e.verdict === "mistake").length;
  const blunderCount = userEvals.filter((e) => e.verdict === "blunder").length;
  const phaseAccs = phases.map((ph) => ({ ...ph, acc: phaseAcc(ph.from, ph.to) }));
  const scoreLabel = (() => {
    if (!analysis?.userColor) return game?.result === "win" ? "1 – 0" : game?.result === "loss" ? "0 – 1" : "½ – ½";
    const userWhite = analysis.userColor === "w";
    if (game?.result === "draw") return "½ – ½";
    if (game?.result === "win") return userWhite ? "1 – 0" : "0 – 1";
    return userWhite ? "0 – 1" : "1 – 0";
  })();
  const whiteWon = scoreLabel.startsWith("1");
  const wasDraw = scoreLabel.includes("½");
  // Piece activity: share of the user's moves per piece (live via chess.js).
  const pieceActivity = (() => {
    const counts: Record<string, number> = { q: 0, r: 0, b: 0, n: 0, p: 0 };
    try {
      const c = new Chess();
      if (game?.pgn) c.loadPgn(game.pgn);
      const hist = c.history({ verbose: true });
      hist.forEach((h, i) => {
        const ply = i + 1;
        if (!isUserP(ply)) return;
        const pc = (h as { piece?: string }).piece ?? "";
        if (pc in counts) counts[pc]++;
      });
    } catch {
      // fall through to SAN fallback below
    }
    let total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0 && detail) {
      // Fallback: infer pawns from SAN shape when PGN replay fails.
      for (const m of detail.moves) {
        const p = (m.ply % 2 === 1) === (analysis?.userColor !== "b");
        if (!p) continue;
        const san = m.san;
        if (/^[a-h][1-8]/.test(san) || /^[a-h]x/.test(san)) counts.p++;
        else if (san.startsWith("N")) counts.n++;
        else if (san.startsWith("B")) counts.b++;
        else if (san.startsWith("R")) counts.r++;
        else if (san.startsWith("Q")) counts.q++;
      }
      total = Object.values(counts).reduce((a, b) => a + b, 0);
    }
    const rows = [
      { key: "Queen", count: counts.q },
      { key: "Rooks", count: counts.r },
      { key: "Bishops", count: counts.b },
      { key: "Knights", count: counts.n },
      { key: "Pawns", count: counts.p },
    ].map((r) => ({ ...r, pct: total === 0 ? 0 : Math.round((r.count / total) * 100) }));
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r) => ({ ...r, width: Math.round((r.count / max) * 100) }));
  })();

  // ---- Opening tab derivations (all real: book + engine + clocks, no mocks) ----
  // Preview state lives here so opening + analysis tabs share it.
  const [preview, setPreview] = useState<{ ply: number; fen: string } | null>(null);
  const fmtTime = (secs: number | null): string => {
    if (secs === null || !Number.isFinite(secs)) return "—";
    const s = Math.max(0, Math.round(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const openingFullName = detail?.opening?.name ?? "Unknown Opening";
  const openingSplit = openingFullName.split(":");
  const openingMain = openingSplit[0]?.trim() || "Unknown Opening";
  const openingVarRaw = openingSplit.slice(1).join(":").trim();
  // Dataset names end in "Variation" ("Najdorf Variation"); the Details row
  // shows the short form ("Najdorf") like the mock, the header keeps the full name.
  const openingVarShort = openingVarRaw.replace(/\s+[Vv]ariation$/, "");
  const bookPly = detail?.opening?.bookPly ?? 0;
  const bookMoves = Math.ceil(bookPly / 2);
  // Opening = the opening phase (moves 1..oEnd), same as Stats/Summary,
  // so Opening Performance matches the Stats chart. Book length only feeds
  // "Theory followed", not the range.
  const openingEndPly = Math.min(totalMoves, oEnd * 2);
  const openingEndMove = oEnd;
  const openingAccuracy = phaseAcc(1, openingEndMove);
  const accDelta = openingAccuracy !== null && analysis ? openingAccuracy - analysis.accuracy : null;
  const openingEvals = (analysis?.evals ?? []).filter((e) => e.ply <= openingEndPly);
  const openingUserEvals = openingEvals.filter((e) => isUserP(e.ply));
  const openingUserCount = openingUserEvals.length;
  const inBook = bookPly > 0;
  // Time spent from real [%clk] stamps. spent(ply) = prev same-color clock - clock + increment.
  const clockByPly = new Map((detail?.moves ?? []).map((m) => [m.ply, m.clockSecs ?? null]));
  const incSecs = detail?.incrementSecs ?? 0;
  const baseSecs = detail?.baseSecs ?? null;
  function spentForPly(p: number): number | null {
    const cur = clockByPly.get(p);
    if (cur === undefined || cur === null) return null;
    const prevPly = p - 2;
    if (prevPly >= 1) {
      const prev = clockByPly.get(prevPly);
      if (prev === undefined || prev === null) return null;
      return Math.max(0, prev - cur + incSecs);
    }
    if (baseSecs !== null) return Math.max(0, baseSecs - cur + incSecs);
    return null;
  }
  const openingUserSpent = (() => {
    let sum = 0;
    let any = false;
    for (const e of openingUserEvals) {
      const s = spentForPly(e.ply);
      if (s !== null) { sum += s; any = true; }
    }
    return any ? sum : null;
  })();
  const totalUserSpent = (() => {
    let sum = 0;
    let any = false;
    for (const e of (analysis?.evals ?? []).filter((x) => isUserP(x.ply))) {
      const s = spentForPly(e.ply);
      if (s !== null) { sum += s; any = true; }
    }
    return any ? sum : null;
  })();
  const hasClocks = openingUserSpent !== null || totalUserSpent !== null;
  // Board cursor for the opening tab (stays inside the opening range).
  const opCursor = opPly === null ? openingEndPly : Math.max(0, Math.min(opPly, openingEndPly));
  const opBoardFen = opCursor === 0
    ? detail?.initialFen
    : (detail?.moves[opCursor - 1]?.fen ?? detail?.initialFen);
  const opCursorLabel = opCursor === 0
    ? "Start"
    : (() => {
        const m = detail?.moves[opCursor - 1];
        return m ? `${m.moveNo}. ${m.san}` : "Start";
      })();
  // Key Opening Moves: every pair in the opening range. Real game moves.
  const keyMovePairs: { no: number; w: string; b?: string }[] = [];
  if (detail) {
    const list = detail.moves.slice(0, openingEndPly);
    for (let i = 0; i < list.length; i += 2) {
      keyMovePairs.push({ no: list[i].moveNo, w: list[i].san, b: list[i + 1]?.san });
    }
  }
  // Same-piece-twice detection (real, via chess.js verbose history, user moves in opening).
  const repeatInfo: { san1: string; san2: string } | null = (() => {
    try {
      if (!game?.pgn || !detail) return null;
      const c = new Chess();
      c.loadPgn(game.pgn);
      const hist = c.history({ verbose: true }) as unknown as {
        from: string; to: string; piece: string; san: string; color: string;
      }[];
      const userCol = analysis?.userColor ?? ((hist[0]?.color ?? "w") as "w" | "b");
      let prev: { from: string; to: string; san: string } | null = null;
      for (let i = 0; i < hist.length && i < openingEndPly; i++) {
        const h = hist[i];
        if (h.color !== userCol) continue;
        if (prev && h.from === prev.to) return { san1: prev.san, san2: h.san };
        prev = { from: h.from, to: h.to, san: h.san };
      }
      return null;
    } catch {
      return null;
    }
  })();
  // Short one-line feedback, engine + book only.
  const ouBlunders = openingUserEvals.filter((e) => e.verdict === "blunder").length;
  const ouMistakes = openingUserEvals.filter((e) => e.verdict === "mistake").length;
  const ouGood = openingUserEvals.filter((e) =>
    ["best", "great", "brilliant", "good"].includes(e.verdict ?? "good")).length;
  const wentWell: string[] = [];
  const toImprove: string[] = [];
  if (analysis && detail) {
    if (bookPly > 0)
      wentWell.push(`Followed opening theory for the first ${bookMoves} move${bookMoves === 1 ? "" : "s"}.`);
    if (ouBlunders === 0 && ouMistakes === 0 && openingUserCount > 0)
      wentWell.push("No blunders or mistakes in the opening.");
    else if (ouGood > 0 && openingUserCount > 0)
      wentWell.push(`${ouGood} of ${openingUserCount} moves were best or solid.`);
    if (repeatInfo) toImprove.push(`Moved the same piece twice (${repeatInfo.san1}–${repeatInfo.san2}).`);
    const slips = openingUserEvals
      .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
      .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0));
    if (slips[0] && slips[0].bestSan && slips[0].bestSan !== slips[0].san)
      toImprove.push(`Could have played ${slips[0].bestSan} instead of ${slips[0].san}.`);
    for (const s of slips.slice(toImprove.length === 0 ? 0 : 1, 3)) {
      if (toImprove.length >= 3) break;
      toImprove.push(`${moveNoOf(s.ply)}. ${s.san} was a ${s.verdict} (−${((s.deltaCp ?? 0) / 100).toFixed(1)}).`);
    }
    if (bookPly > 0 && bookPly < openingEndPly && toImprove.length < 3) {
      toImprove.push(`Left book at move ${Math.floor(bookPly / 2) + 1}.`);
    }
  }
  // Related Alternatives: best move + actual reply, pill = pawns saved. Real only.
  const relatedAlts = openingUserEvals
    .filter((e) => e.bestSan && e.bestSan !== e.san)
    .slice(0, 2)
    .map((e) => ({
      ply: e.ply,
      best: e.bestSan as string,
      reply: detail?.moves[e.ply]?.san ?? "",
      saved: `+${((e.deltaCp ?? 0) / 100).toFixed(1)}`,
    }));
  const theoryStatus = !inBook
    ? { label: "Out of book", cls: "st-out" }
    : bookPly >= openingEndPly
      ? { label: "Fully followed", cls: "st-full" }
      : { label: "Partially followed", cls: "st-part" };
  // Design format: "1.e4 c5 - 10 moves".
  const openingRangeText = (() => {
    if (!detail || openingEndPly === 0) return `1. - ${openingEndMove} moves`;
    const w1 = detail.moves[0]?.san ?? "";
    const b1 = detail.moves[1]?.san ?? "";
    return `1.${w1} ${b1} - ${openingEndMove} moves`;
  })();

  // ---- Middlegame tab derivations (same sources as opening: engine + clocks, no mocks) ----
  const midFrom = oEnd + 1;
  const midTo = mEnd;
  const midStartPly = Math.min(totalMoves, (midFrom - 1) * 2 + 1);
  const midEndPly = Math.min(totalMoves, midTo * 2);
  const midHasRange = detail !== null && midEndPly >= midStartPly && midTo >= midFrom;
  const midAccuracy = phaseAcc(midFrom, midTo);
  const midDelta = midAccuracy !== null && analysis ? midAccuracy - analysis.accuracy : null;
  const midEvals = (analysis?.evals ?? []).filter((e) => e.ply >= midStartPly && e.ply <= midEndPly);
  const midUserEvals = midEvals.filter((e) => isUserP(e.ply));
  const midUserCount = midUserEvals.length;
  const midUserSpent = (() => {
    let sum = 0;
    let any = false;
    for (const e of midUserEvals) {
      const s = spentForPly(e.ply);
      if (s !== null) { sum += s; any = true; }
    }
    return any ? sum : null;
  })();
  const midHasClocks = midUserSpent !== null || totalUserSpent !== null;
  // Position quality: mean user-perspective eval across the middlegame, in pawns.
  const userSign = analysis?.userColor === "b" ? -1 : 1;
  const midPosQuality = (() => {
    if (midUserEvals.length === 0) return null;
    const avg = midUserEvals.reduce((s, e) => s + e.evalCp * userSign, 0) / midUserEvals.length;
    return avg / 100;
  })();
  const fmtSignedPawns = (v: number | null): string => {
    if (v === null || !Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
  };
  // Tactical opportunities: real slips + real finds in the middlegame (user moves).
  const midSlips = midUserEvals
    .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
    .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0));
  const midFinds = midUserEvals
    .filter((e) => e.verdict === "brilliant" || e.verdict === "great" || (e.verdict === "best" && swingP(e.ply) >= 50))
    .sort((a, b) => swingP(b.ply) - swingP(a.ply));
  const midTacticalCount = midSlips.length + midFinds.length;
  // Key Moments: worst 2 slips + best find, chronological. Fill with biggest
  // absolute swings when the phase is clean.
  const midKeyMoments: MoveEval[] = (() => {
    const picked = [...midSlips.slice(0, 2), ...midFinds.slice(0, 1)];
    if (picked.length < 3) {
      const pickedSet = new Set(picked.map((e) => e.ply));
      const rest = midUserEvals
        .filter((e) => !pickedSet.has(e.ply))
        .sort((a, b) => Math.abs(swingP(b.ply)) - Math.abs(swingP(a.ply)));
      for (const e of rest) {
        if (picked.length >= 3) break;
        picked.push(e);
      }
    }
    return picked.sort((a, b) => a.ply - b.ply).slice(0, 3);
  })();
  const midMomentLabel = (e: MoveEval): string => {
    const v = e.verdict ?? "good";
    if (v === "brilliant" || v === "great" || v === "best") return "Strong decision";
    if (v === "blunder" || v === "mistake") return "Missed opportunity";
    return "Inaccuracy";
  };
  const midWentWell: string[] = [];
  const midToImprove: string[] = [];
  if (analysis && detail && midHasRange) {
    const bl = midUserEvals.filter((e) => e.verdict === "blunder").length;
    const mi = midUserEvals.filter((e) => e.verdict === "mistake").length;
    if (bl === 0 && mi === 0 && midUserCount > 0)
      midWentWell.push(`No blunders or mistakes from moves ${midFrom}–${midTo}.`);
    if (midFinds.length > 0)
      midWentWell.push(`Found ${midFinds.length} strong tactic${midFinds.length === 1 ? "" : "s"} in the middlegame.`);
    else if (midUserCount > 0)
      midWentWell.push(`${midUserEvals.filter((e) => ["best", "good"].includes(e.verdict ?? "good")).length} of ${midUserCount} middlegame moves were solid.`);
    if (midPosQuality !== null && midPosQuality >= 0.3)
      midWentWell.push(`Kept a plus position (avg ${fmtSignedPawns(midPosQuality)}).`);
    for (const s of midSlips.slice(0, 3)) {
      const better = s.bestSan && s.bestSan !== s.san ? ` Best was ${moveNoOf(s.ply)}. ${s.bestSan}.` : "";
      midToImprove.push(`${moveNoOf(s.ply)}. ${s.san} gave up −${((s.deltaCp ?? 0) / 100).toFixed(1)}.${better}`);
      if (midToImprove.length >= 3) break;
    }
    if (midToImprove.length === 0)
      midToImprove.push("No middlegame slips found — review the endgame instead.");
  }
  // Key Middlegame Themes: all derived from engine numbers + move history.
  const midThemes = (() => {
    type Tier = { label: string; cls: string };
    const tier = (ok: boolean, mid: boolean): Tier =>
      ok ? { label: "Good", cls: "st-full" } : mid ? { label: "Average", cls: "st-part" } : { label: "Needs improvement", cls: "st-bad" };
    // Central presence: share of user's middlegame moves landing on c/d/e/f files,
    // ranks 3-6 (real, via chess.js verbose history).
    let centerPct: number | null = null;
    let kingMoves = 0;
    try {
      if (game?.pgn) {
        const c = new Chess();
        c.loadPgn(game.pgn);
        const hist = c.history({ verbose: true }) as unknown as { to: string; piece: string; color: string }[];
        const userCol = analysis?.userColor ?? "w";
        let central = 0;
        let total = 0;
        hist.forEach((h, i) => {
          const p = i + 1;
          if (p < midStartPly || p > midEndPly) return;
          if (h.color !== userCol) return;
          total++;
          if (h.piece === "k") kingMoves++;
          const f = h.to.charCodeAt(0) - 97;
          const r = Number(h.to[1]);
          if (f >= 2 && f <= 5 && r >= 3 && r <= 6) central++;
        });
        if (total > 0) centerPct = (central / total) * 100;
      }
    } catch {
      centerPct = null;
    }
    const found = midFinds.length;
    const missed = midSlips.length;
    const totalTac = found + missed;
    const tacRate = totalTac === 0 ? null : found / totalTac;
    const trendFirst = midEvals.length > 0 ? midEvals[0].evalCp * userSign : null;
    const trendLast = midEvals.length > 0 ? midEvals[midEvals.length - 1].evalCp * userSign : null;
    const trendGain = trendFirst !== null && trendLast !== null ? trendLast - trendFirst : null;
    const midAcc = midAccuracy ?? 0;
    return [
      { key: "Center control", ...tier((centerPct ?? 0) >= 40, (centerPct ?? 0) >= 25), hint: centerPct === null ? undefined : `${Math.round(centerPct)}% central` },
      { key: "Piece activity", ...tier(midAcc >= 75, midAcc >= 60) },
      { key: "King safety", ...tier(missed === 0 && kingMoves <= 1, missed <= 1 && kingMoves <= 2) },
      { key: "Tactical awareness", ...tier((tacRate ?? 0) >= 0.6, (tacRate ?? 0) >= 0.35 || totalTac === 0) },
      { key: "Strategic planning", ...tier((trendGain ?? 0) >= 30, (trendGain ?? -999) >= -60) },
    ];
  })();
  // Position Quality Trend: user-perspective eval per ply across the middlegame.
  const midTrendPts = midEvals.map((e) => ({
    ply: e.ply,
    moveNo: moveNoOf(e.ply),
    v: Math.max(-250, Math.min(250, e.evalCp * userSign)) / 100,
  }));
  const midCursor = midPly === null ? midEndPly : Math.max(midStartPly, Math.min(midPly, midEndPly));
  const midBoardFen = midHasRange
    ? (detail?.moves[midCursor - 1]?.fen ?? detail?.initialFen)
    : detail?.initialFen;
  const midCursorLabel = (() => {
    const m = detail?.moves[midCursor - 1];
    return m ? `${m.moveNo}. ${m.san}` : "Start";
  })();

  // ---- Endgame tab derivations (same sources as opening/mid: engine + clocks + board, no mocks) ----
  const endFrom = mEnd + 1;
  const endTo = totalMoveNos;
  const endStartPly = Math.min(totalMoves, mEnd * 2 + 1);
  const endEndPly = totalMoves;
  const endHasRange = detail !== null && totalMoves > 0 && endTo >= endFrom && endStartPly <= endEndPly;
  const endAccuracy = phaseAcc(endFrom, endTo);
  const endDelta = endAccuracy !== null && analysis ? endAccuracy - analysis.accuracy : null;
  const endEvals = (analysis?.evals ?? []).filter((e) => e.ply >= endStartPly && e.ply <= endEndPly);
  const endUserEvals = endEvals.filter((e) => isUserP(e.ply));
  const endUserCount = endUserEvals.length;
  const endUserSpent = (() => {
    let sum = 0;
    let any = false;
    for (const e of endUserEvals) {
      const s = spentForPly(e.ply);
      if (s !== null) { sum += s; any = true; }
    }
    return any ? sum : null;
  })();
  const endHasClocks = endUserSpent !== null || totalUserSpent !== null;
  // The exact ply the gate fired on (see computePhases), so the label can
  // never describe a different position than the range.
  const endGatePly = phaseBounds.endStartMove === null ? null : Math.min(totalMoves, phaseBounds.endStartMove * 2);
  const endEvalPly = endGatePly ?? endStartPly;
  const endStartFen = endHasRange && endGatePly !== null ? (detail?.moves[endGatePly - 1]?.fen ?? null) : null;
  const endFinalFen = endHasRange
    ? (detail?.moves[endEndPly - 1]?.fen ?? detail?.initialFen)
    : detail?.initialFen;
  const endType = endStartFen ? endgameTypeLabel(endStartFen) : null;
  const endTypeText = endType ? `${endType.type} · ${endType.complexity}` : "—";
  const endUserCol = (analysis?.userColor ?? "w") as "w" | "b";
  // Material balance at the endgame start, from the user's perspective.
  const endBalance = (() => {
    if (!endStartFen) return { label: "—", cls: "st-part" };
    const diff = Math.round(materialPawnDiff(endStartFen) * userSign);
    if (Math.abs(diff) < 1) return { label: "Equal", cls: "st-part" };
    return diff > 0
      ? { label: `+${diff} for you`, cls: "st-full" }
      : { label: `${diff}`, cls: "st-bad" };
  })();
  // King activity: centralisation at the end + share of king moves in range.
  const endKing = (() => {
    if (!endHasRange || !endFinalFen) return { label: "—", cls: "st-part", moves: 0, sub: "" };
    let kingMoves = 0;
    try {
      if (game?.pgn) {
        const c = new Chess();
        c.loadPgn(game.pgn);
        const hist = c.history({ verbose: true }) as unknown as { to: string; piece: string; color: string }[];
        hist.forEach((h, i) => {
          const p = i + 1;
          if (p < endStartPly || p > endEndPly) return;
          if (h.color !== endUserCol) return;
          if (h.piece === "k") kingMoves++;
        });
      }
    } catch {
      // ignore, centrality below still applies
    }
    const central = kingCentralDistance(kingSquare(endFinalFen, endUserCol)) <= 2;
    const label =
      kingMoves >= 2 || (central && kingMoves >= 1)
        ? "Good"
        : kingMoves >= 1 || central
          ? "Average"
          : "Passive";
    const cls = label === "Good" ? "st-full" : label === "Average" ? "st-part" : "st-bad";
    return { label, cls, moves: kingMoves, sub: kingMoves === 1 ? "1 king move" : `${kingMoves} king moves` };
  })();
  // Pawn structure at the end of the game, user's pawns.
  const endPawns = (() => {
    if (!endHasRange || !endFinalFen) return { label: "—", cls: "st-part", sub: "" };
    const h = pawnHealth(endFinalFen, endUserCol);
    const weak = h.doubled + h.isolated;
    const label = weak === 0 ? "Solid" : weak <= 2 ? "Weakened" : "Fragile";
    const cls = label === "Solid" ? "st-full" : label === "Weakened" ? "st-part" : "st-bad";
    const sub = h.passed > 0
      ? `${h.passed} passed`
      : weak === 0
        ? "no weaknesses"
        : `${weak} weak`;
    return { label, cls, sub };
  })();
  // Conversion: one opportunity when the user starts the endgame winning.
  const endConversion = (() => {
    if (!analysis || !endHasRange || !endStartFen)
      return { won: null as number | null, total: 0, label: "—", sub: "" };
    const startUserEval = userSign * evalAfterP(endEvalPly);
    const total = startUserEval > 150 ? 1 : 0;
    if (total === 0) return { won: null, total, label: "—", sub: "never winning" };
    const won = game?.result === "win" ? 1 : 0;
    const sub = game?.result === "win" ? "won" : game?.result === "draw" ? "drawn" : "lost";
    return { won, total, label: `${won} / ${total}`, sub };
  })();
  // Simplified theoretical verdict from material + eval (not a tablebase).
  const endTheory = (() => {
    if (!endHasRange || !endStartFen) return "—";
    const diff = materialPawnDiff(endStartFen) * userSign;
    const ev = userSign * evalAfterP(endEvalPly);
    if (diff >= 3 || ev >= 300) return "Winning";
    if (diff <= -3 || ev <= -300) return "Losing";
    if (Math.abs(diff) <= 1 && Math.abs(ev) < 150) return "Draw";
    return "Unclear";
  })();
  const endSlips = endUserEvals
    .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
    .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0));
  const endFinds = endUserEvals
    .filter((e) => e.verdict === "brilliant" || e.verdict === "great" || (e.verdict === "best" && swingP(e.ply) >= 50))
    .sort((a, b) => swingP(b.ply) - swingP(a.ply));
  // Key Moments: worst 2 slips + best find, chronological. Fill with biggest
  // absolute swings when the phase is clean.
  const endKeyMoments: MoveEval[] = (() => {
    const picked = [...endSlips.slice(0, 2), ...endFinds.slice(0, 1)];
    if (picked.length < 3) {
      const pickedSet = new Set(picked.map((e) => e.ply));
      const rest = endUserEvals
        .filter((e) => !pickedSet.has(e.ply))
        .sort((a, b) => Math.abs(swingP(b.ply)) - Math.abs(swingP(a.ply)));
      for (const e of rest) {
        if (picked.length >= 3) break;
        picked.push(e);
      }
    }
    return picked.sort((a, b) => a.ply - b.ply).slice(0, 3);
  })();
  const endMomentLabel = (e: MoveEval): string => {
    const v = e.verdict ?? "good";
    if (v === "blunder" || v === "mistake") return "Missed conversion";
    if (v === "inaccuracy") return "Inaccuracy";
    return userSign * e.evalCp >= 150 ? "Winning position" : "Finished well";
  };
  const endWentWell: string[] = [];
  const endToImprove: string[] = [];
  if (analysis && detail && endHasRange) {
    const bl = endUserEvals.filter((e) => e.verdict === "blunder").length;
    const mi = endUserEvals.filter((e) => e.verdict === "mistake").length;
    if (bl === 0 && mi === 0 && endUserCount > 0)
      endWentWell.push(`No blunders or mistakes from moves ${endFrom}–${endTo}.`);
    if (endConversion.total === 1 && endConversion.won === 1)
      endWentWell.push("Converted the winning endgame.");
    if (endKing.moves >= 2)
      endWentWell.push(`Activated the king (${endKing.moves} king moves).`);
    else if (endUserCount > 0)
      endWentWell.push(`${endUserEvals.filter((e) => ["best", "good"].includes(e.verdict ?? "good")).length} of ${endUserCount} endgame moves were solid.`);
    if (endPawns.label === "Solid")
      endWentWell.push("Kept a solid pawn structure.");
    for (const s of endSlips.slice(0, 3)) {
      const better = s.bestSan && s.bestSan !== s.san ? ` Best was ${moveNoOf(s.ply)}. ${s.bestSan}.` : "";
      endToImprove.push(`${moveNoOf(s.ply)}. ${s.san} gave up −${((s.deltaCp ?? 0) / 100).toFixed(1)}.${better}`);
      if (endToImprove.length >= 3) break;
    }
    if (endToImprove.length === 0)
      endToImprove.push("No endgame slips found — a clean conversion.");
  }
  const endCursor = endPly === null ? endEndPly : Math.max(endStartPly, Math.min(endPly, endEndPly));
  const endBoardFen = endHasRange
    ? (detail?.moves[endCursor - 1]?.fen ?? detail?.initialFen)
    : detail?.initialFen;
  const endCursorLabel = (() => {
    const m = detail?.moves[endCursor - 1];
    return m ? `${m.moveNo}. ${m.san}` : "Start";
  })();

  // ---- Tactics tab derivations (engine + board geometry, no mocks) ----
  // Opportunity = a real swing: user miss (blunder/mistake/inaccuracy with
  // best move and loss >= 60cp) or user find (brilliant/great, or best with
  // mover swing >= 50cp). Opponent slips are shown separately as context.
  type TacMoment = {
    ply: number;
    moveNo: number;
    san: string;
    kind: "missed" | "found";
    tactic: TacticType;
    title: string;
    text: string;
    deltaCp: number;
    bestSan?: string;
  };
  const fenBeforePly = (p: number): string =>
    p <= 1 ? (detail?.initialFen ?? "") : (detail?.moves[p - 2]?.fen ?? "");
  const fenAfterPly = (p: number): string =>
    detail?.moves[p - 1]?.fen ?? detail?.initialFen ?? "";
  const tacticOf = (ply: number): TacticType => {
    const e = evalByPly.get(ply);
    if (!e || !detail) return "Other";
    const mover: "w" | "b" = ply % 2 === 1 ? "w" : "b";
    const fb = fenBeforePly(ply);
    const fa = fenAfterPly(ply);
    if (!fb || !fa) return "Other";
    // For misses, classify the BEST move's idea (what was missed). For finds
    // and opponent moves, classify the played move.
    const isMiss = e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy";
    const sanForIdea = isMiss && e.bestSan ? e.bestSan : e.san;
    const moverWhite = mover === "w";
    const afterCp = e.evalCp;
    const actualMover = moverWhite ? afterCp : -afterCp;
    // Material change of the idea move (best move for misses).
    let matDiff = 0;
    try {
      const c = new Chess(fb);
      const before = c.fen();
      c.move(sanForIdea);
      matDiff = moverMaterialDiffCp(before, c.fen(), mover);
    } catch {
      matDiff = moverMaterialDiffCp(fb, fa, mover);
    }
    return classifyTactic({
      fenBefore: fb,
      fenAfter: isMiss && e.bestSan ? (() => {
        try {
          const c = new Chess(fb);
          c.move(e.bestSan as string);
          return c.fen();
        } catch {
          return fa;
        }
      })() : fa,
      san: sanForIdea,
      mover,
      moverMaterialDiff: matDiff,
      keepEvalCp: isMiss ? actualMover + (e.deltaCp ?? 0) : actualMover,
    }).type;
  };
  const tacUserMisses: TacMoment[] = (analysis?.evals ?? [])
    .filter((e) => isUserP(e.ply))
    .filter((e) => e.verdict === "blunder" || e.verdict === "mistake" || e.verdict === "inaccuracy")
    .filter((e) => (e.deltaCp ?? 0) >= 60 && e.bestSan && e.bestSan !== e.san)
    .sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0))
    .map((e) => {
      const tactic = tacticOf(e.ply);
      const article = tactic === "Other" ? "a tactic" : `a ${tactic.toLowerCase()}`;
      return {
        ply: e.ply,
        moveNo: moveNoOf(e.ply),
        san: e.san,
        kind: "missed" as const,
        tactic,
        title: `Move ${moveNoOf(e.ply)} · Missed ${tactic === "Other" ? "tactic" : tactic.toLowerCase()}`,
        text: `You could have played ${moveNoOf(e.ply)}. ${e.bestSan} instead of ${e.san} (${article}, −${((e.deltaCp ?? 0) / 100).toFixed(1)}).`,
        deltaCp: e.deltaCp ?? 0,
        bestSan: e.bestSan,
      };
    });
  const tacUserFinds: TacMoment[] = (analysis?.evals ?? [])
    .filter((e) => isUserP(e.ply))
    .filter((e) => e.verdict === "brilliant" || e.verdict === "great" || (e.verdict === "best" && swingP(e.ply) >= 50))
    .sort((a, b) => swingP(b.ply) - swingP(a.ply))
    .map((e) => {
      const tactic = tacticOf(e.ply);
      const v = e.verdict ?? "best";
      const title = v === "brilliant" || v === "great"
        ? `Move ${moveNoOf(e.ply)} · Strong ${tactic === "Other" ? "tactic" : tactic.toLowerCase()}`
        : `Move ${moveNoOf(e.ply)} · You found the ${tactic === "Other" ? "tactic" : tactic.toLowerCase()}`;
      const text = v === "brilliant"
        ? `Brilliant ${e.san} — you gave material and kept the initiative.`
        : v === "great"
          ? `Excellent calculation! ${moveNoOf(e.ply)}. ${e.san} wins material.`
          : `Well played ${moveNoOf(e.ply)}. ${e.san} — the engine's top choice.`;
      return {
        ply: e.ply,
        moveNo: moveNoOf(e.ply),
        san: e.san,
        kind: "found" as const,
        tactic,
        title,
        text,
        deltaCp: e.deltaCp ?? 0,
      };
    });
  // Your tactics only — opponent moves never count here.
  const tacAllMine: TacMoment[] = [...tacUserMisses, ...tacUserFinds].sort((a, b) => a.ply - b.ply);
  const tacTotal = tacAllMine.length;
  const tacMissed = tacUserMisses.length;
  const tacFound = tacUserFinds.length;
  const tacRate = tacTotal === 0 ? null : Math.round((tacFound / tacTotal) * 100);
  // Displayed list is capped at the 8 most significant moments (worst
  // misses + biggest finds), chronological for reading. Types + donut
  // describe exactly this displayed Top 8 — labels below say so.
  const tacImpact = (m: TacMoment): number =>
    m.kind === "missed" ? m.deltaCp : swingP(m.ply);
  const tacMoments: TacMoment[] = [...tacAllMine]
    .sort((a, b) => tacImpact(b) - tacImpact(a))
    .slice(0, 8)
    .sort((a, b) => a.ply - b.ply);
  const tacShowing = tacMoments.length;
  const tacTypeCounts = TACTIC_LEGEND.map((t) => ({
    type: t,
    count: tacMoments.filter((m) => m.tactic === t).length,
  }));
  const tacDonutTotal = Math.max(1, tacShowing);
  const tacDonutColors: Record<string, string> = {
    "Fork": "#3b82f6",
    "Pin": "#22a35c",
    "Skewer": "#14b8a6",
    "Discovered attack": "#f59e0b",
    "Sacrifice": "#ef4444",
    "Double check": "#8b5cf6",
    "Deflection": "#ec4899",
    "Other": "#cbd5e1",
  };
  // SVG donut segments for tactic types.
  const tacSegments = (() => {
    const R = 48;
    const C = 2 * Math.PI * R;
    let acc = 0;
    const segs: { type: string; dash: string; offset: number; color: string }[] = [];
    for (const row of tacTypeCounts) {
      if (row.count === 0) continue;
      const frac = row.count / tacDonutTotal;
      segs.push({
        type: row.type,
        dash: `${frac * C} ${C}`,
        offset: -acc * C,
        color: tacDonutColors[row.type] ?? "#94a3b8",
      });
      acc += frac;
    }
    return { C, segs };
  })();
  const tacInsight = (() => {
    if (!analysis) return "";
    if (tacTotal === 0) return "No clear tactical swings in this game — it was decided positionally. Keep scanning for forcing moves every turn.";
    // "Mostly X" reflects all your moments, not just the displayed Top 8.
    const fullCounts = TACTIC_LEGEND.map((t) => ({
      type: t,
      count: tacAllMine.filter((m) => m.tactic === t).length,
    }));
    const byType = [...fullCounts].sort((a, b) => b.count - a.count).filter((x) => x.count > 0);
    const topTypes = byType.slice(0, 2).map((x) => `${x.type.toLowerCase()}s`).join(" and ");
    const vision = (tacRate ?? 0) >= 60 ? "Your tactical vision is good" : "Your tactical vision needs work";
    const missedBit = tacMissed === 0
      ? "you converted everything you found"
      : `you missed ${tacMissed} tactical opportunit${tacMissed === 1 ? "y" : "ies"}${topTypes ? `, mostly ${topTypes}` : ""}`;
    return `${vision}, but ${missedBit}. ${tacMissed > 0 ? "Check for forcing moves before making a quiet move." : "Keep punishing loose pieces the same way."}`;
  })();
  // Practice card removed per design — missed moments are reviewed inline.

  // Summary-tab jumps stay on the summary board (no tab switch).
  // showBest=true previews the engine's best move in place (toggle);
  // showBest=false jumps to the game move and clears any preview.
  function jumpToAnalysis(p: number, showBest: boolean) {
    if (!detail) return;
    if (showBest) {
      if (preview && preview.ply === p) {
        setPreview(null);
        setPly(p);
        return;
      }
      try {
        const e = evalByPly.get(p);
        const fb = p <= 1 ? detail.initialFen : detail.moves[p - 2]?.fen;
        if (e?.bestSan && fb) {
          const c = new Chess(fb);
          c.move(e.bestSan);
          setPreview({ ply: p, fen: c.fen() });
        } else {
          setPreview(null);
        }
      } catch {
        setPreview(null);
      }
    } else {
      setPreview(null);
    }
    setPly(p);
  }

  // Show-variation preview: best move played on the board instead of the game move.
  const position = preview && preview.ply === ply
    ? preview.fen
    : ply === 0 ? detail?.initialFen : detail?.moves[ply - 1]?.fen;

  function toggleVariation() {
    if (!shown || !detail) return;
    if (preview && preview.ply === ply) {
      setPreview(null);
      return;
    }
    if (!shown.bestSan) return;
    try {
      const fenBefore = ply <= 1 ? detail.initialFen : detail.moves[ply - 2]?.fen;
      if (!fenBefore) return;
      const c = new Chess(fenBefore);
      c.move(shown.bestSan);
      setPreview({ ply, fen: c.fen() });
    } catch {
      setPreview(null);
    }
  }

  return (
    <section>
      <div className="crumbs">
        <button type="button" className="crumb-link" onClick={() => navigate("/games")}>
          ← My Games
        </button>
        <span className="crumb-sep">›</span>
        <span className="crumb-current">{game?.opponent ?? "Game"}</span>
      </div>

      {error && <p className="error">{error}</p>}
      {!detail && !error && <p className="muted">Loading game…</p>}

      {game && detail && position && (
        <div className="detail-card">
          <div className="detail-head">
            <div className="detail-title">
              <span className="opp-avatar lg">{game.opponent.charAt(0).toUpperCase()}</span>
              <div>
                <div className="detail-name">
                  {game.opponent}
                  <span className={`mini-pill ${game.result}`}>
                    {game.result === "win" ? "Win" : game.result === "loss" ? "Loss" : "Draw"}
                  </span>
                </div>
                <div className="detail-meta">{meta}</div>
              </div>
            </div>
            <div className="detail-actions">
              <button
                type="button"
                className="btn-light"
                onClick={runDeep}
                disabled={analyzing || explaining || depthUsed === DEEP_DEPTH}
                title={`Re-run Stockfish at depth ${DEEP_DEPTH} for stronger verdicts`}
              >
                {analyzing || explaining
                  ? "Analyzing…"
                  : depthUsed === DEEP_DEPTH
                    ? `Deep ✓ (d${DEEP_DEPTH})`
                    : `Deep analysis (d${DEEP_DEPTH})`}
              </button>
              <button type="button" className="btn-light" disabled title="Journal comes later">
                ⎙ Save to Journal
              </button>
            </div>
          </div>

          <div className="detail-tabs">
            {(["analysis", "summary", "stats", "opening", "middlegame", "endgame", "tactics"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === "analysis" ? (
          <>
          <div className="detail-grid" onPointerDown={stopAuto}>
            <div className="moves-col">
              {rows.map((r) => (
                <div className="move-row" key={r.moveNo}>
                  <span className="move-no">{r.moveNo}.</span>
                  <button
                    type="button"
                    className={r.wPly === ply ? "mv active" : "mv"}
                    onClick={() => r.wPly && setPly(r.wPly)}
                  >
                    {r.w}
                  </button>
                  <button
                    type="button"
                    className={r.bPly === ply ? "mv active" : "mv"}
                    onClick={() => r.bPly && setPly(r.bPly)}
                  >
                    {r.b ?? ""}
                  </button>
                </div>
              ))}
            </div>

            <div className="board-col">
              <PlayerBar name={topPlayer} color={topColor} />
              <Chessboard options={{ position, allowDragging: false, boardOrientation: orientation }} />
              <PlayerBar name={bottomPlayer} color={bottomColor} />
              <div className="board-nav">
                <button type="button" onClick={() => setPly(0)} disabled={ply === 0}>|◀</button>
                <button type="button" onClick={() => setPly((p) => Math.max(0, p - 1))} disabled={ply === 0}>◀</button>
                <button type="button" className="nav-label" disabled>
                  {ply === 0 ? "Start" : `${detail.moves[ply - 1].moveNo}. ${detail.moves[ply - 1].san}`}
                </button>
                <button type="button" onClick={() => setPly((p) => Math.min(totalMoves, p + 1))} disabled={ply === totalMoves}>▶</button>
                <button type="button" onClick={() => setPly(totalMoves)} disabled={ply === totalMoves}>▶|</button>
                <button type="button" title="Flip board" onClick={() => setFlipped((f) => !f)}>⇄</button>
              </div>
            </div>

            <div className={`eval-col verdict-${shown?.verdict ?? "none"}`}>
              <div className="eval-head">
                <span className="eval-title">
                  {analyzing || explaining ? "Analyzing…" : shown ? (
                    <>{(shown.verdict === "blunder" || shown.verdict === "mistake") && "! "}{shown.verdict}</>
                  ) : "Engine analysis"}
                </span>
                <span className="eval-score">
                  {analyzing || explaining ? "…" : shown ? fmtDelta(shown.deltaCp ?? 0) : "—"}
                </span>
              </div>
              {(analyzing || explaining) && (
                <p className="muted">
                  {depthUsed === DEEP_DEPTH
                    ? `Deep analysis (depth ${DEEP_DEPTH}) — engine + coach together…`
                    : `Quick analysis (depth ${QUICK_DEPTH}) — engine + coach together…`}
                </p>
              )}
              {!analyzing && !explaining && shown && (
                <>
                  <p className="eval-move">
                    {moveNoOf(shown.ply)}. {shown.san}
                    {shownIsOpponent && <span className="mini-pill draw"> Opponent</span>}
                  </p>
                  <p className="eval-text">{noteText}</p>
                  <div className="eval-block">
                    <strong>Why?</strong>
                    {noteWhys.length > 0 ? (
                      <ul className="eval-whys">
                        {noteWhys.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    ) : explainError ? (
                      <p className="error">Coach failed: {explainError}</p>
                    ) : (
                      <p className="muted">
                        Engine note above{explainError ? " (coach unavailable)" : ""}.
                      </p>
                    )}
                  </div>
                  <div className="best-card">
                    <div className="best-row">
                      <div>
                        <strong>Best move</strong>
                        <p className="eval-best">{bestLabel}</p>
                        <button type="button" className="link-btn" onClick={toggleVariation}>
                          {preview ? "Hide variation" : "Show variation"}
                        </button>
                      </div>
                      <span className="best-eval">{bestEvalLabel}</span>
                    </div>
                  </div>
                </>
              )}
              {!analyzing && !explaining && !shown && (
                <p className="muted">Pending Stockfish analysis.</p>
              )}
            </div>
          </div>

          <div className="timeline" onPointerDown={stopAuto}>
            <strong>Game Timeline</strong>
            <div className="timeline-phases">
              {[
                { label: "Opening", moves: opening },
                { label: "Middlegame", moves: middlegame },
                { label: "Endgame", moves: endgame },
              ].map((ph) => (
                <div key={ph.label}>
                  <div className="phase-label">{ph.label}</div>
                  <div className="timeline-dots">
                    {ph.moves.map((m) => {
                      const v = evalByPly.get(m.ply)?.verdict;
                      const mine = analysis?.userColor
                        ? (analysis.userColor === "w") === (m.ply % 2 === 1)
                        : true;
                      return (
                        <button
                          key={m.ply}
                          type="button"
                          title={`${m.moveNo}. ${m.san}`}
                          onClick={() => setPly(m.ply)}
                          className={`dot v-${v ?? "none"}${mine ? "" : " opp"}${m.ply <= ply ? " on" : ""}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          </>
        ) : null}
        </div>
      )}
      {game && detail && position && tab === "summary" && (
        <div className="summary-wrap">
          <div className="summary-grid">
            <div className="card-pad summary-board">
              <PlayerBar name={topPlayer} color={topColor} />
              <Chessboard options={{ position, allowDragging: false, boardOrientation: orientation }} />
              <PlayerBar name={bottomPlayer} color={bottomColor} />
              <div className="board-nav">
                <button type="button" onClick={() => setPly(0)} disabled={ply === 0}>|◀</button>
                <button type="button" onClick={() => setPly((p) => Math.max(0, p - 1))} disabled={ply === 0}>◀</button>
                <button type="button" className="nav-label" disabled>
                  {ply === 0 ? "Start" : `${detail.moves[ply - 1].moveNo}. ${detail.moves[ply - 1].san}`}
                </button>
                <button type="button" onClick={() => setPly((p) => Math.min(totalMoves, p + 1))} disabled={ply === totalMoves}>▶</button>
                <button type="button" onClick={() => setPly(totalMoves)} disabled={ply === totalMoves}>▶|</button>
              </div>
            </div>
            <div className="summary-side">
            <div className="card-pad summary-game">
              <div className="sum-head">
                <strong>Game Summary</strong>
                {analyzing || explaining ? (
                  <span className="muted">Analyzing…</span>
                ) : (
                  <span className="sum-acc">Accuracy <b>{analysis?.accuracy ?? "—"}%</b></span>
                )}
              </div>
              <div className="sum-result">
                <span className={`result-pill ${game.result}`}>
                  <span className="result-dot">{game.result === "win" ? "✓" : game.result === "loss" ? "✕" : "="}</span>
                  {game.result === "win" ? "Win" : game.result === "loss" ? "Loss" : "Draw"}
                </span>
                <span className="muted">{analyzing || explaining ? "Working through the game…" : resultLine}</span>
              </div>
              <div className="sum-phases">
                {phases.map((ph) => {
                  const acc = phaseAcc(ph.from, ph.to);
                  return (
                    <div className="sum-phase" key={ph.key}>
                      <span className={`dot sm ${ph.dot}`} />
                      <div className="sum-phase-text">
                        <span className="sum-phase-label">{ph.key}</span>
                        <small className="muted">{ph.sub}</small>
                      </div>
                      <div className="bar"><span style={{ width: `${acc ?? 0}%` }} /></div>
                      <span className={`phase-tag tier-${tierOf(acc)}`}>{phaseLabel(acc)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
              <div className="summary-subcards">
                <div className="card-pad sum-mini">
                  <strong className="sum-mini-title">Best Move</strong>
                  {bestUserMove ? (
                    <>
                      <div className="sum-mini-move"><span>{moveNoOf(bestUserMove.ply)}. {bestUserMove.san}</span><span className="sum-delta-pos">{fmtCp(evalByPly.get(bestUserMove.ply)?.evalCp ?? 0)}</span></div>
                      <button type="button" className="link-btn" onClick={() => jumpToAnalysis(bestUserMove.ply, true)}>
                        {preview && preview.ply === bestUserMove.ply ? "(Hide variation)" : "(Show variation)"}
                      </button>
                    </>
                  ) : (
                    <p className="muted">{analyzing || explaining ? "Analyzing…" : "No standout move."}</p>
                  )}
                </div>
                <div className="card-pad sum-mini">
                  <strong className="sum-mini-title">Biggest Mistake</strong>
                  {biggestSlip ? (
                    <>
                      <div className="sum-mini-move"><span>{moveNoOf(biggestSlip.ply)}. {biggestSlip.san}</span><span className="sum-delta-neg">{fmtDelta(biggestSlip.deltaCp ?? 0)}</span></div>
                      <button type="button" className="link-btn" onClick={() => jumpToAnalysis(biggestSlip.ply, false)}>
                        (Show explanation)
                      </button>
                    </>
                  ) : (
                    <p className="muted">{analyzing || explaining ? "Analyzing…" : "Clean game."}</p>
                  )}
                </div>
                <div className="card-pad sum-mini">
                  <strong className="sum-mini-title">Turning Point</strong>
                  {turning ? (
                    <>
                      <p className="eval-best">Move {moveNoOf(turning.ply)}</p>
                      <p className="muted">{turningText}</p>
                    </>
                  ) : (
                    <p className="muted">{analyzing || explaining ? "Analyzing…" : "—"}</p>
                  )}
                </div>
              </div>
              <div className="card-pad sum-card">
                <strong>⌖ Key Takeaways</strong>
                <ul className="eval-whys">
                  {shownTakeaways.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
      {game && detail && position && tab === "stats" && (
        <div className="stats-wrap">
          {analyzing || explaining ? (
            <div className="detail-card"><p className="muted">Analyzing… engine + coach together.</p></div>
          ) : !analysis ? (
            <div className="detail-card"><p className="muted">Pending Stockfish analysis.</p></div>
          ) : (
            <>
              <div className="stats-top">
                <div className="card-pad">
                  <strong className="card-title">Accuracy</strong>
                  <div className="acc-donut-row">
                    <svg viewBox="0 0 120 120" className="donut">
                      <circle cx="60" cy="60" r="48" fill="none" stroke="#eef0f4" strokeWidth="12" />
                      <circle
                        cx="60" cy="60" r="48" fill="none" stroke="#34c98e" strokeWidth="12"
                        strokeLinecap="round"
                        strokeDasharray={`${((analysis.accuracy ?? 0) / 100) * 301.6} 301.6`}
                        transform="rotate(-90 60 60)"
                      />
                      <text x="60" y="58" textAnchor="middle" className="donut-num">{analysis.accuracy}%</text>
                      <text x="60" y="74" textAnchor="middle" className="donut-sub">Your accuracy</text>
                    </svg>
                    <div className="acc-sides">
                      <div className="acc-side"><span className="dot sm d-open" />{accWhite ?? "—"}%<small>White</small></div>
                      <div className="acc-side"><span className="dot sm d-mid" />{accBlack ?? "—"}%<small>Black</small></div>
                    </div>
                  </div>
                </div>
                <div className="card-pad">
                  <strong className="card-title">Move Quality</strong>
                  <p className="muted small">Your moves · {userEvals.length} moves</p>
                  <div className="q-list">
                    {qualityCounts.map((q) => (
                      <div className="q-row" key={q.verdict}>
                        <span className={`dot sm v-${q.verdict === "good" ? "good" : q.verdict === "inaccuracy" ? "inaccuracy" : q.verdict}`} />
                        <span className="q-label">{q.verdict[0].toUpperCase() + q.verdict.slice(1)}</span>
                        <div className="bar q-bar"><span style={{ width: `${(q.count / maxQuality) * 100}%` }} /></div>
                        <span className="q-count">{q.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card-pad">
                  <strong className="card-title">Game Result</strong>
                  <div className="score-big">{scoreLabel}</div>
                  <p className="muted small">{game.result === "win" ? "Win" : game.result === "loss" ? "Loss" : "Draw"}</p>
                  <div className="q-list">
                    <div className="q-row"><span className="dot sm d-open" /><span className="q-label">White</span><div className="bar q-bar"><span style={{ width: `${wasDraw ? 50 : whiteWon ? 100 : 0}%` }} /></div><span className="q-count">{wasDraw ? "½" : whiteWon ? 1 : 0}</span></div>
                    <div className="q-row"><span className="dot sm d-mid" /><span className="q-label">Draw</span><div className="bar q-bar"><span style={{ width: `${wasDraw ? 100 : 0}%` }} /></div><span className="q-count">{wasDraw ? 1 : 0}</span></div>
                    <div className="q-row"><span className="dot sm v-blunder" /><span className="q-label">Black</span><div className="bar q-bar"><span style={{ width: `${wasDraw ? 50 : whiteWon ? 0 : 100}%` }} /></div><span className="q-count">{wasDraw ? "½" : whiteWon ? 0 : 1}</span></div>
                  </div>
                </div>
              </div>
              <div className="stats-mid">
                <div className="card-pad">
                  <strong className="card-title">Accuracy by Phase</strong>
                  <svg viewBox="0 0 400 140" className="phase-chart">
                    {[0, 25, 50, 75, 100].map((t) => (
                      <g key={t}>
                        <line x1="32" y1={120 - t * 1} x2="390" y2={120 - t * 1} stroke="#eef0f4" strokeWidth="1" />
                        <text x="4" y={123 - t * 1} className="chart-tick">{t}%</text>
                      </g>
                    ))}
                    <polyline
                      fill="none" stroke="#3b82f6" strokeWidth="2"
                      points={phaseAccs.map((p, i) => `${70 + i * 130},${120 - (p.acc ?? 0) * 1}`).join(" ")}
                    />
                    {phaseAccs.map((p, i) => (
                      <g key={p.key}>
                        <circle cx={70 + i * 130} cy={120 - (p.acc ?? 0) * 1} r="4" fill="#3b82f6" />
                        <text x={70 + i * 130} y="134" textAnchor="middle" className="chart-label">{p.key}</text>
                        <text x={70 + i * 130} y={108 - (p.acc ?? 0) * 1} textAnchor="middle" className="chart-val">{p.acc ?? "—"}%</text>
                      </g>
                    ))}
                  </svg>
                </div>
                <div className="card-pad">
                  <strong className="card-title">Piece Activity</strong>
                  <p className="muted small">Share of your moves per piece</p>
                  <div className="q-list">
                    {pieceActivity.map((r) => (
                      <div className="q-row piece-row" key={r.key}>
                        <span className="q-label piece">{r.key}</span>
                        <div className="bar q-bar"><span style={{ width: `${r.width}%` }} /></div>
                        <span className="q-count">{r.pct}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="stats-bottom">
                <div className="card-pad key-stat">
                  <small className="muted">Avg. centipawn loss (you)</small>
                  <div className="key-num">{avgCpl ?? "—"}</div>
                </div>
                <div className="card-pad key-stat">
                  <small className="muted">Your mistakes</small>
                  <div className="key-num">{mistakeCount}</div>
                </div>
                <div className="card-pad key-stat">
                  <small className="muted">Your blunders</small>
                  <div className="key-num">{blunderCount}</div>
                </div>
                <div className="card-pad key-stat">
                  <small className="muted">Time Control</small>
                  <div className="key-num tc">{game.timeControl}</div>
                  <small className="muted">{totalMoveNos} moves</small>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {game && detail && tab === "opening" && (
        <div className="opening-wrap">
          <div className="opening-grid">
            <div className="op-card">
              <div className="op-head">
                <strong>Opening Analysis</strong>
                <span className="op-meta-pill">
                  Moves 1–{openingEndMove} <span className="op-sep">✦</span> {hasClocks ? fmtTime(openingUserSpent) : "—"} <span className="op-sep">✦</span> {openingAccuracy ?? "—"}%
                </span>
              </div>
              <div className="op-name-line">
                {openingMain}{openingVarRaw ? <span className="op-dot"> · </span> : null}
                {openingVarRaw ? <span className="op-var-inline">{openingVarRaw}</span> : null}
              </div>
              <div className="op-mid">
                <div className="op-board-col">
                  <PlayerBar name={topPlayer} color={topColor} />
                  {opBoardFen && (
                    <div className="op-board">
                      <Chessboard options={{
                        position: opBoardFen,
                        allowDragging: false,
                        showNotation: true,
                        boardOrientation: orientation,
                        darkSquareStyle: { backgroundColor: "#A5714F" },
                        lightSquareStyle: { backgroundColor: "#EBD2B1" },
                      }} />
                    </div>
                  )}
                  <PlayerBar name={bottomPlayer} color={bottomColor} />
                  <div className="op-nav">
                    <button type="button" onClick={() => setOpPly(0)} disabled={opCursor === 0}>|◀</button>
                    <button type="button" onClick={() => setOpPly(Math.max(0, opCursor - 1))} disabled={opCursor === 0}>◀</button>
                    <span className="op-nav-label">{opCursorLabel}</span>
                    <button type="button" onClick={() => setOpPly(Math.min(openingEndPly, opCursor + 1))} disabled={opCursor === openingEndPly}>▶</button>
                    <button type="button" onClick={() => setOpPly(openingEndPly)} disabled={opCursor === openingEndPly}>▶|</button>
                  </div>
                </div>
                <div className="op-rightcol">
                  <div className="op-card-sm">
                    <div className="op-sec-title">Opening Performance</div>
                    <div className="op-perf-top">
                      <svg viewBox="0 0 120 120" className="donut op-donut">
                        <circle cx="60" cy="60" r="48" fill="none" stroke="#eef0f4" strokeWidth="12" />
                        <circle
                          cx="60" cy="60" r="48" fill="none" stroke="#34c98e" strokeWidth="12"
                          strokeLinecap="round"
                          strokeDasharray={`${((openingAccuracy ?? 0) / 100) * 301.6} 301.6`}
                          transform="rotate(-90 60 60)"
                        />
                        <text x="60" y="58" textAnchor="middle" className="donut-num">{openingAccuracy ?? "—"}%</text>
                        <text x="60" y="74" textAnchor="middle" className="donut-sub">Accuracy</text>
                      </svg>
                      {accDelta !== null && (
                        <span className={`op-delta${accDelta < 0 ? " neg" : ""}`}>
                          <svg viewBox="0 0 10 10" aria-hidden="true"><path d={accDelta < 0 ? "M1.5 5h7" : "M5 1.5v7M1.5 5h7"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                          {accDelta >= 0 ? `+${accDelta}%` : `${accDelta}%`}
                        </span>
                      )}
                    </div>
                    <div className="op-stats-box">
                      <div className="op-stat">
                        <span className="op-label">Time spent</span>
                        <span className="op-big">{hasClocks ? fmtTime(openingUserSpent) : "—"}</span>
                        <span className="op-sub">{hasClocks ? `(of ${fmtTime(totalUserSpent)})` : "(no clock data)"}</span>
                      </div>
                      <div className="op-stat">
                        <span className="op-label">Theory followed</span>
                        <span className="op-big">{bookMoves} / {openingEndMove}</span>
                        <span className="op-sub">moves</span>
                      </div>
                    </div>
                  </div>
                  <div className="op-card-sm">
                    <div className="op-sec-title">Key Opening Moves</div>
                    <div className="op-keymoves">
                      {(showAllKeyMoves ? keyMovePairs : keyMovePairs.slice(0, 3)).map((p) => (
                        <Fragment key={p.no}>
                          <span className="mv-no">{p.no}.</span>
                          <span className="mv-san">{p.w}</span>
                          <span className="mv-san">{p.b ?? ""}</span>
                        </Fragment>
                      ))}
                    </div>
                    {keyMovePairs.length > 3 && (
                      <div className="op-viewall-row">
                        <button type="button" className="op-viewall" onClick={() => setShowAllKeyMoves((v) => !v)}>
                          {showAllKeyMoves ? "Show less" : "View all moves →"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="op-fb">
                <div className="op-fb-good">
                  <div className="op-fb-title"><span className="fb-ico ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span> What went well</div>
                  <ul>
                    {wentWell.map((w, i) => <li key={i}><span className="fb-ico sm ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>{w}</span></li>)}
                    {wentWell.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
                <div className="op-fb-bad">
                  <div className="op-fb-title"><span className="fb-ico no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span> What could be better</div>
                  <ul>
                    {toImprove.map((w, i) => <li key={i}><span className="fb-ico sm no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span><span>{w}</span></li>)}
                    {toImprove.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
              </div>
            </div>
            <div className="op-side">
              <div className="op-side-card">
                <div className="op-side-title">Opening Details</div>
                <div className="op-kv"><span>Opening name</span><b>{openingMain}</b></div>
                <div className="op-kv"><span>Variation</span><b>{openingVarShort || "—"}</b></div>
                <div className="op-kv"><span>Move range</span><b className="clip">{openingRangeText}</b></div>
                <div className="op-kv"><span>Theory status</span><span className={`op-pill ${theoryStatus.cls}`}>{theoryStatus.label}</span></div>
                <div className="op-kv"><span>Book line</span><b>({bookMoves} move{bookMoves === 1 ? "" : "s"})</b></div>
                <div className="op-kv"><span>Opening accuracy</span><b>{openingAccuracy ?? "—"}%</b></div>
                <div className="op-kv"><span>Time in opening</span><b>{hasClocks ? fmtTime(openingUserSpent) : "—"}</b></div>
              </div>
              <div className="op-side-card">
                <div className="op-side-title">Related Alternatives</div>
                {relatedAlts.length === 0 ? (
                  <p className="muted small">{analysis ? "No engine alternatives in your opening." : "Pending Stockfish analysis."}</p>
                ) : relatedAlts.map((a) => (
                  <div className="op-alt" key={a.ply}>
                    <span className="op-alt-icon">♞</span>
                    <div className="op-alt-body">
                      <div className="op-alt-move">{a.best}{a.reply ? ` ${a.reply}` : ""}</div>
                    </div>
                    <span className="op-tag">{a.saved}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {game && detail && tab === "middlegame" && (
        <div className="opening-wrap">
          <div className="opening-grid">
            <div className="op-card">
              <div className="op-head">
                <strong>Middlegame Analysis</strong>
                <span className="op-meta-pill">
                  {midHasRange ? `Moves ${midFrom}–${midTo}` : "Not reached"} <span className="op-sep">✦</span> {midHasClocks ? fmtTime(midUserSpent) : "—"} <span className="op-sep">✦</span> {midAccuracy ?? "—"}%
                </span>
              </div>
              <div className="op-name-line">
                {midHasRange ? (
                  <span className="op-var-inline">The middlegame begins after move {oEnd} and lasts until move {midTo}.</span>
                ) : (
                  <span className="op-var-inline">No middlegame — the game ended in the opening.</span>
                )}
              </div>
              <div className="op-mid">
                <div className="op-board-col">
                  <PlayerBar name={topPlayer} color={topColor} />
                  {midBoardFen && (
                    <div className="op-board">
                      <Chessboard options={{
                        position: midBoardFen,
                        allowDragging: false,
                        showNotation: true,
                        boardOrientation: orientation,
                        darkSquareStyle: { backgroundColor: "#A5714F" },
                        lightSquareStyle: { backgroundColor: "#EBD2B1" },
                      }} />
                    </div>
                  )}
                  <PlayerBar name={bottomPlayer} color={bottomColor} />
                  <div className="op-nav">
                    <button type="button" onClick={() => setMidPly(midStartPly)} disabled={!midHasRange || midCursor === midStartPly}>|◀</button>
                    <button type="button" onClick={() => setMidPly(Math.max(midStartPly, midCursor - 1))} disabled={!midHasRange || midCursor === midStartPly}>◀</button>
                    <span className="op-nav-label">{midCursorLabel}</span>
                    <button type="button" onClick={() => setMidPly(Math.min(midEndPly, midCursor + 1))} disabled={!midHasRange || midCursor === midEndPly}>▶</button>
                    <button type="button" onClick={() => setMidPly(midEndPly)} disabled={!midHasRange || midCursor === midEndPly}>▶|</button>
                  </div>
                </div>
                <div className="op-rightcol">
                  <div className="op-card-sm">
                    <div className="op-sec-title">Middlegame Performance</div>
                    <div className="op-perf-top">
                      <svg viewBox="0 0 120 120" className="donut op-donut">
                        <circle cx="60" cy="60" r="48" fill="none" stroke="#eef0f4" strokeWidth="12" />
                        <circle
                          cx="60" cy="60" r="48" fill="none" stroke="#34c98e" strokeWidth="12"
                          strokeLinecap="round"
                          strokeDasharray={`${((midAccuracy ?? 0) / 100) * 301.6} 301.6`}
                          transform="rotate(-90 60 60)"
                        />
                        <text x="60" y="58" textAnchor="middle" className="donut-num">{midAccuracy ?? "—"}%</text>
                        <text x="60" y="74" textAnchor="middle" className="donut-sub">Accuracy</text>
                      </svg>
                      {midDelta !== null && (
                        <span className={`op-delta${midDelta < 0 ? " neg" : ""}`}>
                          <svg viewBox="0 0 10 10" aria-hidden="true"><path d={midDelta < 0 ? "M1.5 5h7" : "M5 1.5v7M1.5 5h7"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                          {midDelta >= 0 ? `+${midDelta}%` : `${midDelta}%`}
                        </span>
                      )}
                    </div>
                    <div className="op-stats-box three">
                      <div className="op-stat">
                        <span className="op-label">Time spent</span>
                        <span className="op-big">{midHasClocks ? fmtTime(midUserSpent) : "—"}</span>
                        <span className="op-sub">{midHasClocks ? `(of ${fmtTime(totalUserSpent)})` : "(no clock data)"}</span>
                      </div>
                      <div className="op-stat">
                        <span className="op-label">Position quality</span>
                        <span className="op-big">{fmtSignedPawns(midPosQuality)}</span>
                        <span className="op-sub">avg eval</span>
                      </div>
                      <div className="op-stat">
                        <span className="op-label">Tactical opportunities</span>
                        <span className="op-big">{analysis ? midTacticalCount : "—"}</span>
                        <span className="op-sub">found + missed</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="op-sec-title">Key Moments</div>
              {!analysis ? (
                <p className="muted small">{analyzing || explaining ? "Analyzing…" : "Pending Stockfish analysis."}</p>
              ) : midKeyMoments.length === 0 ? (
                <p className="muted small">No middlegame moves to review.</p>
              ) : (
                <div className="mid-moments">
                  {midKeyMoments.map((e) => {
                    const firstLine = (explanations[e.ply] ?? localNote(e.ply) ?? "").split("\n")[0];
                    const sw = swingP(e.ply);
                    return (
                      <div className="mid-moment" key={e.ply}>
                        <span className={`dot sm v-${e.verdict ?? "good"}`} />
                        <div className="mid-moment-body">
                          <div className="mid-moment-top">
                            <span className="mid-moment-move">Move {moveNoOf(e.ply)} · {midMomentLabel(e)}</span>
                            <span className={`mid-swing${sw < 0 ? " neg" : ""}`}>
                              {sw >= 0 ? "+" : ""}{(sw / 100).toFixed(1)}
                            </span>
                          </div>
                          {firstLine && <p className="mid-moment-text">{firstLine}</p>}
                        </div>
                        <button type="button" className="op-viewall" onClick={() => setMidPly(e.ply)}>
                          View position
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="op-fb">
                <div className="op-fb-good">
                  <div className="op-fb-title"><span className="fb-ico ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span> What you did well</div>
                  <ul>
                    {midWentWell.map((w, i) => <li key={i}><span className="fb-ico sm ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>{w}</span></li>)}
                    {midWentWell.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
                <div className="op-fb-bad">
                  <div className="op-fb-title"><span className="fb-ico no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span> What to improve</div>
                  <ul>
                    {midToImprove.map((w, i) => <li key={i}><span className="fb-ico sm no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span><span>{w}</span></li>)}
                    {midToImprove.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
              </div>
            </div>
            <div className="op-side">
              <div className="op-side-card">
                <div className="op-side-title">Key Middlegame Themes</div>
                {!analysis ? (
                  <p className="muted small">{analyzing || explaining ? "Analyzing…" : "Pending Stockfish analysis."}</p>
                ) : (
                  <div className="mid-themes">
                    {midThemes.map((t) => (
                      <div className="mid-theme-row" key={t.key}>
                        <span className="mid-theme-key">{t.key}</span>
                        <span className={`op-pill ${t.cls}`}>{t.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="op-side-card">
                <div className="op-side-title">Position Quality Trend</div>
                {!analysis || midTrendPts.length === 0 ? (
                  <p className="muted small">{analyzing || explaining ? "Analyzing…" : "No trend data."}</p>
                ) : (
                  <svg viewBox="0 0 260 110" className="mid-trend">
                    {[-2, 0, 2].map((t) => (
                      <g key={t}>
                        <line x1="24" y1={55 - t * 20} x2="252" y2={55 - t * 20} stroke="#eef0f4" strokeWidth="1" />
                        <text x="4" y={58 - t * 20} className="chart-tick">{t > 0 ? `+${t}` : `${t}`}</text>
                      </g>
                    ))}
                    <polyline
                      fill="none" stroke="#34c98e" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                      points={midTrendPts.map((p, i) => {
                        const x = midTrendPts.length === 1 ? 138 : 24 + (i / (midTrendPts.length - 1)) * 228;
                        return `${x},${55 - p.v * 20}`;
                      }).join(" ")}
                    />
                    {midTrendPts.map((p, i) => {
                      const x = midTrendPts.length === 1 ? 138 : 24 + (i / (midTrendPts.length - 1)) * 228;
                      return <circle key={p.ply} cx={x} cy={55 - p.v * 20} r="2.5" fill="#34c98e" />;
                    })}
                    {[midTrendPts[0], midTrendPts[Math.floor(midTrendPts.length / 4)], midTrendPts[Math.floor(midTrendPts.length / 2)], midTrendPts[Math.floor((midTrendPts.length * 3) / 4)], midTrendPts[midTrendPts.length - 1]]
                      .filter((p, i, arr) => p && arr.findIndex((q) => q && q.moveNo === p.moveNo) === i)
                      .map((p) => {
                        const idx = midTrendPts.findIndex((q) => q.ply === p!.ply);
                        const x = midTrendPts.length === 1 ? 138 : 24 + (idx / (midTrendPts.length - 1)) * 228;
                        return <text key={p!.ply} x={x} y="104" textAnchor="middle" className="chart-label">{p!.moveNo}</text>;
                      })}
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {game && detail && tab === "endgame" && (
        <div className="opening-wrap">
          <div className="opening-grid">
            <div className="op-card">
              <div className="op-head">
                <strong>Endgame Analysis</strong>
                <span className="op-meta-pill">
                  {endHasRange ? `Moves ${endFrom}–${endTo}` : "Not reached"} <span className="op-sep">✦</span> {endHasClocks ? fmtTime(endUserSpent) : "—"} <span className="op-sep">✦</span> {endAccuracy ?? "—"}%
                </span>
              </div>
              <div className="op-name-line">
                {endHasRange ? (
                  <span className="op-var-inline">{endTypeText}</span>
                ) : (
                  <span className="op-var-inline">No endgame — the game ended before the endgame.</span>
                )}
              </div>
              <div className="op-mid">
                <div className="op-board-col">
                  <PlayerBar name={topPlayer} color={topColor} />
                  {endBoardFen && (
                    <div className="op-board">
                      <Chessboard options={{
                        position: endBoardFen,
                        allowDragging: false,
                        showNotation: true,
                        boardOrientation: orientation,
                        darkSquareStyle: { backgroundColor: "#A5714F" },
                        lightSquareStyle: { backgroundColor: "#EBD2B1" },
                      }} />
                    </div>
                  )}
                  <PlayerBar name={bottomPlayer} color={bottomColor} />
                  <div className="op-nav">
                    <button type="button" onClick={() => setEndPly(endStartPly)} disabled={!endHasRange || endCursor === endStartPly}>|◀</button>
                    <button type="button" onClick={() => setEndPly(Math.max(endStartPly, endCursor - 1))} disabled={!endHasRange || endCursor === endStartPly}>◀</button>
                    <span className="op-nav-label">{endCursorLabel}</span>
                    <button type="button" onClick={() => setEndPly(Math.min(endEndPly, endCursor + 1))} disabled={!endHasRange || endCursor === endEndPly}>▶</button>
                    <button type="button" onClick={() => setEndPly(endEndPly)} disabled={!endHasRange || endCursor === endEndPly}>▶|</button>
                  </div>
                </div>
                <div className="op-rightcol">
                  <div className="op-card-sm">
                    <div className="op-sec-title">Endgame Performance</div>
                    <div className="op-perf-top">
                      <svg viewBox="0 0 120 120" className="donut op-donut">
                        <circle cx="60" cy="60" r="48" fill="none" stroke="#eef0f4" strokeWidth="12" />
                        <circle
                          cx="60" cy="60" r="48" fill="none" stroke="#34c98e" strokeWidth="12"
                          strokeLinecap="round"
                          strokeDasharray={`${((endAccuracy ?? 0) / 100) * 301.6} 301.6`}
                          transform="rotate(-90 60 60)"
                        />
                        <text x="60" y="58" textAnchor="middle" className="donut-num">{endAccuracy ?? "—"}%</text>
                        <text x="60" y="74" textAnchor="middle" className="donut-sub">Accuracy</text>
                      </svg>
                      {endDelta !== null && (
                        <span className={`op-delta${endDelta < 0 ? " neg" : ""}`}>
                          <svg viewBox="0 0 10 10" aria-hidden="true"><path d={endDelta < 0 ? "M1.5 5h7" : "M5 1.5v7M1.5 5h7"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                          {endDelta >= 0 ? `+${endDelta}%` : `${endDelta}%`}
                        </span>
                      )}
                    </div>
                    <div className="op-stats-box three">
                      <div className="op-stat">
                        <span className="op-label">Conversion rate</span>
                        <span className="op-big">{analysis ? endConversion.label : "—"}</span>
                        <span className="op-sub">{endConversion.sub || "converted"}</span>
                      </div>
                      <div className="op-stat">
                        <span className="op-label">King activity</span>
                        <span className="op-big">{endKing.label}</span>
                        <span className="op-sub">{endKing.sub || "endgame king"}</span>
                      </div>
                      <div className="op-stat">
                        <span className="op-label">Pawn structure</span>
                        <span className="op-big">{endPawns.label}</span>
                        <span className="op-sub">{endPawns.sub || "pawns"}</span>
                      </div>
                    </div>
                    <div className="op-kv"><span>Time in endgame</span><b>{endHasClocks ? `${fmtTime(endUserSpent)} (of ${fmtTime(totalUserSpent)})` : "—"}</b></div>
                  </div>
                </div>
              </div>
              <div className="op-sec-title">Key Moments</div>
              {!analysis ? (
                <p className="muted small">{analyzing || explaining ? "Analyzing…" : "Pending Stockfish analysis."}</p>
              ) : !endHasRange ? (
                <p className="muted small">No endgame moves to review.</p>
              ) : endKeyMoments.length === 0 ? (
                <p className="muted small">No endgame moves to review.</p>
              ) : (
                <div className="mid-moments">
                  {endKeyMoments.map((e) => {
                    const firstLine = (explanations[e.ply] ?? localNote(e.ply) ?? "").split("\n")[0];
                    const sw = swingP(e.ply);
                    return (
                      <div className="mid-moment" key={e.ply}>
                        <span className={`dot sm v-${e.verdict ?? "good"}`} />
                        <div className="mid-moment-body">
                          <div className="mid-moment-top">
                            <span className="mid-moment-move">Move {moveNoOf(e.ply)} · {endMomentLabel(e)}</span>
                            <span className={`mid-swing${sw < 0 ? " neg" : ""}`}>
                              {sw >= 0 ? "+" : ""}{(sw / 100).toFixed(1)}
                            </span>
                          </div>
                          {firstLine && <p className="mid-moment-text">{firstLine}</p>}
                        </div>
                        <button type="button" className="op-viewall" onClick={() => setEndPly(e.ply)}>
                          View position
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="op-fb">
                <div className="op-fb-good">
                  <div className="op-fb-title"><span className="fb-ico ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span> What you did well</div>
                  <ul>
                    {endWentWell.map((w, i) => <li key={i}><span className="fb-ico sm ok"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>{w}</span></li>)}
                    {endWentWell.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
                <div className="op-fb-bad">
                  <div className="op-fb-title"><span className="fb-ico no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span> What to improve</div>
                  <ul>
                    {endToImprove.map((w, i) => <li key={i}><span className="fb-ico sm no"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></span><span>{w}</span></li>)}
                    {endToImprove.length === 0 && <li className="muted">Analyzing…</li>}
                  </ul>
                </div>
              </div>
            </div>
            <div className="op-side">
              <div className="op-side-card">
                <div className="op-side-title">Endgame Details</div>
                <div className="op-kv"><span>Endgame type</span><b>{endType?.type ?? "—"}</b></div>
                <div className="op-kv"><span>Material balance</span><span className={`op-pill ${endBalance.cls}`}>{endBalance.label}</span></div>
                <div className="op-kv"><span>King activity</span><span className={`op-pill ${endKing.cls}`}>{endKing.label}</span></div>
                <div className="op-kv"><span>Pawn structure</span><span className={`op-pill ${endPawns.cls}`}>{endPawns.label}</span></div>
                <div className="op-kv"><span>Conversion rate</span><b>{analysis ? endConversion.label : "—"}</b></div>
                <div className="op-kv"><span>Theoretical result</span><b>{endTheory}</b></div>
                <div className="op-kv"><span>Endgame accuracy</span><b>{endAccuracy ?? "—"}%</b></div>
              </div>
            </div>
          </div>
        </div>
      )}
      {game && detail && tab === "tactics" && (
        <div className="opening-wrap tac-wrap">
          <div className="opening-grid tac-grid">
            <div className="op-card tac-main">
              <div className="tac-head">
                <strong>Tactics Analysis</strong>
                <p className="tac-sub">Your key tactical moments — your misses and finds only.</p>
              </div>
              <div className="tac-stats">
                <div className="tac-stat">
                  <span className="op-label">Total tactical opportunities</span>
                  <span className="tac-stat-num">{analysis ? tacTotal : "—"}</span>
                </div>
                <div className="tac-stat">
                  <span className="op-label">You missed</span>
                  <span className="tac-stat-num miss">{analysis ? tacMissed : "—"}</span>
                </div>
                <div className="tac-stat">
                  <span className="op-label">You found</span>
                  <span className="tac-stat-num hit">{analysis ? tacFound : "—"}</span>
                </div>
                <div className="tac-stat rate">
                  <span className="op-label">Tactic success rate</span>
                  <span className="tac-stat-num">{tacRate === null ? "—" : `${tacRate}%`}</span>
                </div>
              </div>
              <div className="op-sec-title tac-list-title">
                Tactical Moments
                {analysis && tacTotal > tacShowing && (
                  <span className="muted small"> · Top {tacShowing} of {tacTotal} your moments</span>
                )}
              </div>
              {!analysis ? (
                <p className="muted small">{analyzing || explaining ? "Analyzing… engine + coach together." : "Pending Stockfish analysis."}</p>
              ) : tacMoments.length === 0 ? (
                <p className="muted small">No sharp tactical swings — a clean positional game. Review the timeline for the biggest eval changes.</p>
              ) : (
                <div className="tac-list">
                  {(showAllTac ? tacMoments : tacMoments.slice(0, 4)).map((m) => (
                    <div key={m.ply}>
                      <div className="tac-row">
                        <span className={`fb-ico ${m.kind === "missed" ? "no" : "ok"}`}>
                          {m.kind === "missed" ? (
                            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2 8 8 M8 2 2 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                          ) : (
                            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3 3.9 7.6 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          )}
                        </span>
                        <div className="tac-row-body">
                          <div className="tac-row-title">
                            <span className="tac-move">Move {m.moveNo}</span>
                            <span className={`tac-kind ${m.kind === "missed" ? "k-miss" : "k-hit"}`}>
                              {m.kind === "missed"
                                ? `Missed ${m.tactic === "Other" ? "tactic" : m.tactic.toLowerCase()}`
                                : (m.title.replace(`Move ${m.moveNo} · `, ""))}
                            </span>
                          </div>
                          <p className="tac-row-text">{m.text}</p>
                        </div>
                        <span className={`tac-pill ${m.kind === "missed" ? "p-miss" : "p-hit"}`}>{m.tactic}</span>
                        <button
                          type="button"
                          className="op-viewall tac-view"
                          onClick={() => openTacPreview(m.ply)}
                        >
                          {tacViewPly === m.ply ? "Hide" : "View position"}
                        </button>
                      </div>
                      {tacViewPly === m.ply && (() => {
                        const baseFen = tacBefore ? fenBeforePly(m.ply) : fenAfterPly(m.ply);
                        const boardFen = tacPracticeFen ?? baseFen;
                        const tacOrientation = tacFlip
                          ? (orientation === "white" ? "black" : "white")
                          : orientation;
                        const tacTop = tacFlip ? bottomPlayer : topPlayer;
                        const tacTopColor = tacFlip ? bottomColor : topColor;
                        const tacBottom = tacFlip ? topPlayer : bottomPlayer;
                        const tacBottomColor = tacFlip ? topColor : bottomColor;
                        const expectedSan = m.kind === "missed" ? (m.bestSan ?? m.san) : m.san;
                        const norm = (s: string) => s.replace(/[+#?!]+$/, "").trim();
                        return (
                        <div className="tac-preview">
                          <div className="tac-board-col">
                            <PlayerBar name={tacTop} color={tacTopColor} />
                            <div className="tac-board">
                              <Chessboard options={{
                                position: boardFen,
                                allowDragging: true,
                                showNotation: true,
                                boardOrientation: tacOrientation,
                                darkSquareStyle: { backgroundColor: "#A5714F" },
                                lightSquareStyle: { backgroundColor: "#EBD2B1" },
                                onPieceDrop: ({ sourceSquare, targetSquare }) => {
                                  if (!sourceSquare || !targetSquare) return false;
                                  try {
                                    const c = new Chess(boardFen);
                                    const mv = c.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
                                    const firstTry = !tacPracticeFen && !tacBefore
                                      ? false
                                      : !tacPracticeFen;
                                    setTacPracticeFen(c.fen());
                                    if (firstTry) {
                                      if (norm(mv.san) === norm(expectedSan)) {
                                        setTacPracticeMsg(`Correct! ${m.moveNo}. ${mv.san} is the tactic.`);
                                      } else {
                                        setTacPracticeMsg(`Not quite — the idea was ${m.moveNo}. ${expectedSan}. Reset to try again.`);
                                      }
                                    }
                                    return true;
                                  } catch {
                                    return false;
                                  }
                                },
                              }} />
                            </div>
                            <PlayerBar name={tacBottom} color={tacBottomColor} />
                            <div className="op-nav tac-nav">
                              <button type="button" title="Position before the move" onClick={() => { setTacBefore(true); setTacPracticeFen(null); setTacPracticeMsg(""); }} disabled={tacBefore && !tacPracticeFen}>|◀</button>
                              <button type="button" title="Position after the move" onClick={() => { setTacBefore(false); setTacPracticeFen(null); setTacPracticeMsg(""); }} disabled={!tacBefore && !tacPracticeFen}>▶|</button>
                              <button type="button" title="Flip board" onClick={() => setTacFlip((f) => !f)}>⇄</button>
                              <button type="button" title="Reset to game position" onClick={() => { setTacPracticeFen(null); setTacPracticeMsg(""); setTacBefore(false); }}>⟳</button>
                            </div>
                          </div>
                          <div className="tac-preview-side">
                            <div className="tac-preview-move">{m.moveNo}. {m.san}</div>
                            {m.bestSan && m.kind === "missed" && (
                              <div className="muted small">Best was {m.moveNo}. {m.bestSan}</div>
                            )}
                            <div className="muted small">
                              {tacPracticeFen
                                ? "Your line — drag to keep trying."
                                : tacBefore
                                  ? `Position before ${m.moveNo}. ${m.san} — your move.`
                                  : (detail.moves[m.ply - 1] ? `Position after ${m.moveNo}. ${detail.moves[m.ply - 1].san}` : "")}
                            </div>
                            {tacPracticeMsg && <div className="tac-feedback">{tacPracticeMsg}</div>}
                            <div className="tac-actions">
                              <button
                                type="button"
                                className="op-viewall"
                                onClick={() => { setTacBefore(true); setTacPracticeFen(null); setTacPracticeMsg("Your move — find the tactic."); }}
                              >
                                Practice this →
                              </button>
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </div>
                  ))}
                  {tacMoments.length > 4 && (
                    <div className="op-viewall-row">
                      <button type="button" className="op-viewall" onClick={() => setShowAllTac((v) => !v)}>
                        {showAllTac ? "Show less" : `Show all ${tacMoments.length} moments →`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="op-side">
              <div className="op-side-card">
                <div className="op-side-title">
                  Tactic Types
                  {analysis && tacTotal > tacShowing && (
                    <span className="muted small"> · Top {tacShowing}</span>
                  )}
                </div>
                {!analysis ? (
                  <p className="muted small">{analyzing || explaining ? "Analyzing…" : "Pending Stockfish analysis."}</p>
                ) : (
                  <div className="tac-types">
                    {tacTotal > tacShowing && (
                      <p className="muted small">Top {tacShowing} of your {tacTotal} moments by impact.</p>
                    )}
                    <div className="tac-donut-wrap">
                      <svg viewBox="0 0 120 120" className="donut tac-donut">
                        <circle cx="60" cy="60" r="48" fill="none" stroke="#eef0f4" strokeWidth="14" />
                        {tacSegments.segs.map((s) => (
                          <circle
                            key={s.type}
                            cx="60" cy="60" r="48" fill="none"
                            stroke={s.color} strokeWidth="14"
                            strokeDasharray={s.dash}
                            strokeDashoffset={s.offset}
                            transform="rotate(-90 60 60)"
                            strokeLinecap="butt"
                          />
                        ))}
                        <text x="60" y="66" textAnchor="middle" className="donut-num">{tacMoments.length}</text>
                      </svg>
                    </div>
                    <div className="tac-legend">
                      {tacTypeCounts.map((row) => (
                        <div className="tac-legend-row" key={row.type}>
                          <span className="tac-legend-left">
                            <span className="tac-swatch" style={{ background: tacDonutColors[row.type] ?? "#94a3b8" }}>
                              {row.type === "Fork" ? "✕" : row.type === "Pin" ? "●" : row.type === "Skewer" ? "◐" : row.type === "Discovered attack" ? "◎" : row.type === "Sacrifice" ? "♞" : row.type === "Double check" ? "+" : row.type === "Deflection" ? "⇄" : "○"}
                            </span>
                            <span className={row.count === 0 ? "muted" : ""}>{row.type}</span>
                          </span>
                          <span className="q-count">{row.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="tac-insight">
            <span className="tac-insight-ico">◈</span>
            <div>
              <div className="tac-insight-title">Tactics insight</div>
              <p className="tac-insight-text">{analysis ? tacInsight : "Analyzing…"}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

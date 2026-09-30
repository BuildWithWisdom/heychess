import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import type { Game, GameAnalysis, GameDetail as Detail, MoveEval } from "@heychess/contracts";
import "./GameDetail.css";

const API = "http://localhost:3001";
const QUICK_DEPTH = 10;
const DEEP_DEPTH = 16;
// Safety cap per coach call; engine notes cover the rest regardless.
const MAX_CANDIDATES = 12;

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
  const [tab, setTab] = useState<"analysis" | "summary" | "stats" | "openings" | "timeline">("analysis");

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

  const third = Math.max(1, Math.ceil(totalMoves / 3));
  const opening = detail?.moves.slice(0, third) ?? [];
  const middlegame = detail?.moves.slice(third, third * 2) ?? [];
  const endgame = detail?.moves.slice(third * 2) ?? [];

  const worst = analysis
    ? [...analysis.evals].sort((a, b) => (b.deltaCp ?? 0) - (a.deltaCp ?? 0))[0] ?? null
    : null;
  const evalByPly = new Map((analysis?.evals ?? []).map((e) => [e.ply, e]));
  const defaultOrientation = analysis?.userColor === "b" ? "black" : "white";
  const orientation = flipped
    ? defaultOrientation === "black" ? "white" : "black"
    : defaultOrientation;
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
  const totalMoveNos = Math.max(1, Math.ceil(totalMoves / 2));
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
  const oEnd = Math.max(1, Math.round(totalMoveNos * 0.3));
  const mEnd = Math.max(oEnd + 1, Math.round(totalMoveNos * 0.7));
  const phases = [
    { key: "Opening", sub: `(1–${oEnd} moves)`, from: 1, to: oEnd, dot: "d-open" },
    { key: "Middlegame", sub: `(${oEnd + 1}–${mEnd} moves)`, from: oEnd + 1, to: mEnd, dot: "d-mid" },
    { key: "Endgame", sub: `(${mEnd + 1}–${totalMoveNos} moves)`, from: mEnd + 1, to: totalMoveNos, dot: "d-end" },
  ];
  const tierOf = (acc: number | null): string =>
    acc === null ? "weak" : acc >= 85 ? "excellent" : acc >= 75 ? "strong" : acc >= 60 ? "good" : "weak";
  const bestUserMove =
    userEvals
      .filter((e) => e.verdict === "best" || e.verdict === "brilliant")
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
  const [preview, setPreview] = useState<{ ply: number; fen: string } | null>(null);
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
            {(["analysis", "summary", "stats", "openings", "timeline"] as const).map((t) => (
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
              <Chessboard options={{ position, allowDragging: false, boardOrientation: orientation }} />
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
              <Chessboard options={{ position, allowDragging: false, boardOrientation: orientation }} />
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
      {game && detail && tab !== "analysis" && tab !== "summary" && (
        <div className="detail-card">
          <p className="muted">{tab[0].toUpperCase() + tab.slice(1)} lands after engine (1d).</p>
        </div>
      )}
    </section>
  );
}

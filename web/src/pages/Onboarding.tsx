import { useEffect, useRef, useState } from "react";
import type { Game } from "@heychess/contracts";
import signupImg from "../assets/signup.png";
import chesscomLogo from "../assets/chessdotcom.png";
import lichessLogo from "../assets/lichess.png";
import { linkChessProfile } from "../lib/profile.ts";
import { clearGamesCache } from "../utils/gamesCache.ts";
import "./Onboarding.css";

const API = "http://localhost:3001";

// All game endpoints identify the user from the session cookie.
// The linked chess.com handle lives on the user profile — the frontend
// never passes a username for reads or imports.

type Step = 1 | 2 | 3 | 4 | 5;
type CountChoice = 10 | 20 | 30 | "all";

interface Summary {
  total: number;
  wins: number;
  losses: number;
  draws: number;
}

function summarize(games: Game[]): Summary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const g of games) {
    if (g.result === "win") wins += 1;
    else if (g.result === "loss") losses += 1;
    else draws += 1;
  }
  return { total: games.length, wins, losses, draws };
}

async function fetchSlice(limit: number): Promise<Game[]> {
  const res = await fetch(`${API}/api/games?limit=${limit}&refresh=1`, {
    credentials: "include",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "import failed");
  return (data.games ?? []) as Game[];
}

async function fetchFull(signal: AbortSignal): Promise<Game[]> {
  // Kick a full sync, then poll until the backend reports it is done.
  const q = new URLSearchParams({ page: "1", pageSize: "20", full: "1", refresh: "1" });
  for (let i = 0; i < 45; i++) {
    if (signal.aborted) throw new Error("cancelled");
    const res = await fetch(`${API}/api/games?${q}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "import failed");
    if (!data.syncing) return (data.games ?? []) as Game[];
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("import timed out — try again");
}

function goHome() {
  // Full reload so every page picks up the newly linked handle.
  window.location.href = "/";
}

function exploreGames() {
  // Full reload so the games list picks up the newly linked handle.
  window.location.href = "/games";
}

export default function Onboarding() {
  const [step, setStep] = useState<Step>(1);
  const [username, setUsername] = useState("");
  const [total, setTotal] = useState(0);
  const [choice, setChoice] = useState<CountChoice>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [soon, setSoon] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function findGames() {
    const u = username.trim().toLowerCase();
    if (!u) return;
    setBusy(true);
    setError(null);
    try {
      // Cheap existence check first — 404 means unknown chess.com user.
      // This endpoint is public on purpose: the handle isn't linked yet.
      const s = await fetch(`${API}/api/player/stats?username=${encodeURIComponent(u)}`);
      if (!s.ok) {
        const d = await s.json().catch(() => null);
        throw new Error(d?.error ?? "chess.com user not found");
      }
      // The all-time total comes from chess.com stats (nothing imported yet,
      // so the library count would just read 0). Import stores exactly the
      // number picked below — nowhere else imports on your behalf.
      const sData = await s.json();
      await linkChessProfile(u);
      const t = Number(sData.totalGames ?? 0);
      setUsername(u);
      setTotal(t);
      setChoice(t > 0 && t < 30 ? "all" : 30);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    setStep(4);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const games =
        choice === "all" ? await fetchFull(ctl.signal) : await fetchSlice(choice);
      // Drop any locally cached rows so Home/Games can only show
      // this user's just-imported games.
      clearGamesCache();
      setSummary(summarize(games));
      setStep(5);
    } catch (e) {
      if ((e as Error).message === "cancelled") return;
      setError(e instanceof Error ? e.message : "import failed");
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  const dots = [1, 2, 3, 4, 5];

  return (
    <div className="ob-page">
      <header className="ob-top">
        <div className="ob-brand">
          <span className="ob-brand-mark">♜</span>
          <span className="ob-brand-word">HEYCHESS</span>
        </div>
        <div className="ob-progress" aria-label={`Step ${step} of 5`}>
          <span className="ob-progress-label">{step} of 5</span>
          <span className="ob-dots">
            {dots.map((d) => (
              <i key={d} className={d <= step ? "ob-dot on" : "ob-dot"} />
            ))}
          </span>
        </div>
      </header>

      <main className="ob-wrap">
        {step === 1 && (
          <section className="ob-s1">
            <div className="ob-s1-main">
              <p className="ob-kicker">WELCOME TO HEYCHESS</p>
              <h1 className="ob-title">
                Bring your chess
                <br />
                to HeyChess
              </h1>
              <p className="ob-sub">
                Import your recent games to start analyzing your play and discovering
                your patterns.
              </p>

              <p className="ob-label">Where do you play?</p>
              <div className="ob-sources">
                <button type="button" className="ob-source" onClick={() => setStep(2)}>
                  <span className="ob-source-head">
                    <img src={chesscomLogo} alt="" className="ob-source-logo" />
                    <span className="ob-source-name">Chess.com</span>
                  </span>
                  <span className="ob-source-desc">Import your games from Chess.com</span>
                  <span className="ob-source-go">→</span>
                </button>
                <button
                  type="button"
                  className="ob-source"
                  onClick={() => setSoon("Lichess import is coming soon.")}
                >
                  <span className="ob-source-head">
                    <img src={lichessLogo} alt="" className="ob-source-logo" />
                    <span className="ob-source-name">
                      lichess.org <em className="ob-soon">Soon</em>
                    </span>
                  </span>
                  <span className="ob-source-desc">Import your games from Lichess</span>
                  <span className="ob-source-go">→</span>
                </button>
              </div>

              <div className="ob-or">
                <span />
                <em>OR</em>
                <span />
              </div>
              <button
                type="button"
                className="ob-pgn"
                onClick={() => setSoon("PGN upload is coming soon.")}
              >
                <span className="ob-pgn-icon">▤</span> Upload a PGN file
                <span className="ob-pgn-go">›</span>
              </button>

              {soon && (
                <p className="ob-soon-note" role="status">
                  {soon}
                </p>
              )}
              <button type="button" className="ob-skip" onClick={goHome}>
                I&apos;ll do this later
              </button>
            </div>
            <div className="ob-s1-side">
              <img src={signupImg} alt="Black king and white pawn" className="ob-s1-img" />
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="ob-plain">
            <button type="button" className="ob-back" onClick={() => setStep(1)}>
              ← Back
            </button>
            <p className="ob-src-tag">
              <img src={chesscomLogo} alt="" className="ob-src-tag-logo" /> CHESS.COM
            </p>
            <h1 className="ob-title">Enter your Chess.com username</h1>
            <p className="ob-sub">
              We&apos;ll find your public games and import them into HeyChess.
            </p>
            <div className="ob-field">
              <span className="ob-field-icon" aria-hidden>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="5" r="2.6" />
                  <path d="M2.8 13.2c.7-2.4 2.8-3.6 5.2-3.6s4.5 1.2 5.2 3.6" />
                </svg>
              </span>
              <input
                className="ob-input"
                placeholder="yourusername"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findGames()}
                autoComplete="off"
                autoFocus
              />
              {username && (
                <button
                  type="button"
                  className="ob-clear"
                  aria-label="Clear"
                  onClick={() => setUsername("")}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <circle cx="8" cy="8" r="6.2" />
                    <path d="M6 6l4 4M10 6l-4 4" />
                  </svg>
                </button>
              )}
            </div>
            <p className="ob-hint">Your username is the one you use to log in to Chess.com.</p>
            {error && (
              <p className="ob-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="ob-cta"
              disabled={busy || !username.trim()}
              onClick={findGames}
            >
              {busy ? "Finding…" : "Find my games →"}
            </button>
            <p className="ob-foot">
              Don&apos;t have a Chess.com account?{" "}
              <a href="https://www.chess.com/register" target="_blank" rel="noreferrer">
                Create one
              </a>
            </p>
          </section>
        )}

        {step === 3 && (
          <section className="ob-plain">
            <button type="button" className="ob-back" onClick={() => setStep(2)}>
              ← Back
            </button>
            <div className="ob-found">
              <span className="ob-found-check">✓</span>
              <span>
                <strong>Found you!</strong>
                <br />
                <span className="ob-found-sub">@{username} · Chess.com</span>
              </span>
              <span className="ob-found-count">{total} games available</span>
            </div>
            <h2 className="ob-h2">Choose how many games to import</h2>
            <p className="ob-sub">You can always import more later.</p>
            <div className="ob-counts">
              {([10, 20, 30] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={choice === n ? "ob-count on" : "ob-count"}
                  onClick={() => setChoice(n)}
                >
                  <strong>Last {n}</strong>
                  <span>({n} games)</span>
                </button>
              ))}
              <button
                type="button"
                className={choice === "all" ? "ob-count on" : "ob-count"}
                onClick={() => setChoice("all")}
              >
                <strong>All available</strong>
                <span>({total} games)</span>
              </button>
            </div>
            {error && (
              <p className="ob-error" role="alert">
                {error}
              </p>
            )}
            <button type="button" className="ob-cta" disabled={busy} onClick={runImport}>
              Import {choice === "all" ? total : choice} games →
            </button>
            <p className="ob-note">
              ⓘ&nbsp; This will import your public games only. We don&apos;t have access to
              your private games or account details.
            </p>
          </section>
        )}

        {step === 4 && (
          <section className="ob-card ob-center">
            <div className="ob-spinner" aria-hidden>
              <span className="ob-spinner-logo">♟</span>
            </div>
            <h2 className="ob-h2">Importing your games…</h2>
            <p className="ob-sub">
              This may take a few moments. You&apos;ll be redirected automatically once
              it&apos;s complete.
            </p>
            <ul className="ob-tasks">
              <li>
                <span>♟</span> {choice === "all" ? total : choice} games
                <em>from Chess.com</em>
              </li>
              <li>
                <span>◷</span> Analyzing positions <em>with Stockfish</em>
              </li>
              <li>
                <span>◔</span> Preparing your dashboard <em>for you</em>
              </li>
            </ul>
          </section>
        )}

        {step === 5 && summary && (
          <section className="ob-card ob-center">
            <div className="ob-done" aria-hidden>
              ✓
            </div>
            <h1 className="ob-title">Your games are ready!</h1>
            <p className="ob-sub">
              We imported {summary.total} games from Chess.com.
            </p>
            <div className="ob-stats">
              <div className="ob-stat">
                <strong>{summary.total}</strong>
                <span>Games imported</span>
              </div>
              <div className="ob-stat">
                <strong>{summary.wins}</strong>
                <span>Wins</span>
              </div>
              <div className="ob-stat">
                <strong>{summary.losses}</strong>
                <span>Losses</span>
              </div>
            </div>
            <div className="ob-stats ob-stats-2">
              <div className="ob-stat">
                <strong>
                  {summary.total > 0
                    ? Math.round((summary.wins / summary.total) * 100)
                    : 0}
                  %
                </strong>
                <span>Win rate</span>
              </div>
              <div className="ob-stat">
                <strong>{summary.draws}</strong>
                <span>Draws</span>
              </div>
            </div>
            <button type="button" className="ob-cta" onClick={exploreGames}>
              Explore my games →
            </button>
            <button type="button" className="ob-skip" onClick={goHome}>
              Go to home
            </button>
          </section>
        )}
      </main>
    </div>
  );
}

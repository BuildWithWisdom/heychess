import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { InsightsResponse } from "@heychess/contracts";
import { useChessProfile } from "../lib/profile.ts";
import "./Insights.css";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const RANGES = [10, 20, 30, 50] as const;

function formatUpdated(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const KIND_ICON: Record<string, { glyph: string; tint: string }> = {
  patterns: { glyph: "◉", tint: "tint-blue" },
  openings: { glyph: "♞", tint: "tint-green" },
  strength: { glyph: "▲", tint: "tint-amber" },
  area: { glyph: "◈", tint: "tint-purple" },
};

export default function Insights() {
  const { handle: username, loading: profileLoading } = useChessProfile();
  const [range, setRange] = useState<number>(30);
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      if (profileLoading) return;
      if (!username) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${API}/api/insights?limit=${range}`, {
          credentials: "include",
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "insights fetch failed");
        setData(body as InsightsResponse);
      } catch (e) {
        setError(e instanceof Error ? e.message : "load failed");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [username, profileLoading, range]);

  function askCustom() {
    const raw = window.prompt("How many recent games? (5–100)", String(range));
    if (raw === null) return;
    const n = Math.min(100, Math.max(5, Number(raw) || 30));
    setRange(n);
  }

  const isCustom = !(RANGES as readonly number[]).includes(range);

  return (
    <section className="insights">
      <div className="page-head">
        <div>
          <h1>Insights</h1>
          <p>Analyze your games, find patterns, and improve your chess.</p>
        </div>
        <div className="insights-top-pills">
          <span className="conn-pill">
            <span className="conn-avatar">♟</span>
            <span className="conn-text">
              <strong>Chess.com</strong>
              <small>Connected</small>
            </span>
          </span>
        </div>
      </div>

      {!username && !profileLoading && !loading && (
        <div className="card">
          <p className="muted">
            No chess.com account linked yet. <Link to="/welcome">Import your games</Link> to
            get personalized insights.
          </p>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="card analyze-card">
        <div className="analyze-left">
          <strong className="analyze-title">Analyze your chess</strong>
          <p className="muted">Select a range of games to get personalized insights based on your play.</p>
          <div className="range-row">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={range === r ? "tab active" : "tab"}
                onClick={() => setRange(r)}
              >
                Last {r}
              </button>
            ))}
            <button
              type="button"
              className={isCustom ? "tab active" : "tab"}
              onClick={askCustom}
            >
              {isCustom ? `Last ${range}` : "Custom"}
            </button>
          </div>
        </div>
        <div className="analyze-right">
          <span className="analyzed-avatar">◉</span>
          <div>
            <strong>{loading ? "—" : `${data?.total ?? 0} games`}</strong>
            <div className="muted">Analyzed</div>
            <div className="muted small">Last updated: {loading ? "…" : formatUpdated(data?.lastUpdated ?? null)}</div>
          </div>
        </div>
      </div>

      <div className="insights-grid">
        <div className="card profile-card">
          <span className="profile-icon">♞</span>
          <div className="profile-body">
            <small className="muted">Your Chess Profile</small>
            <strong className="profile-name">
              {loading ? "…" : (data?.profile.title ?? "—")}
            </strong>
            <p className="muted">{loading ? "Loading…" : (data?.profile.blurb ?? "")}</p>
          </div>
        </div>
        <div className="card quick-card">
          <strong className="quick-title">Quick Stats</strong>
          {(
            [
              ["Accuracy", data?.quickStats.tactical],
              ["King Safety", data?.quickStats.positional],
              ["Defense", data?.quickStats.defensive],
              ["Late Wins", data?.quickStats.endgame],
            ] as Array<[string, number | undefined]>
          ).map(([label, v]) => (
            <div className="stat-bar-row" key={label}>
              <span className="stat-bar-label">{label}</span>
              <span className="stat-bar-track">
                <span className="stat-bar-fill" style={{ width: `${loading ? 0 : (v ?? 0)}%` }} />
              </span>
              <span className="stat-bar-val">{loading ? "—" : `${v ?? 0}%`}</span>
            </div>
          ))}
        </div>
      </div>

      <small className="muted section-label">Key Insights</small>
      <div className="key-row">
        {(loading ? [] : (data?.keyInsights ?? []).filter((k) => k.kind !== "patterns")).map((k) => {
          const icon = KIND_ICON[k.kind] ?? { glyph: "◈", tint: "tint-blue" };
          return (
            <div className="card key-card" key={k.kind}>
              <span className={`key-icon ${icon.tint}`}>{icon.glyph}</span>
              <span className="key-text">
                <strong>{k.title}</strong>
                <small className="muted">{k.subtitle}</small>
              </span>
            </div>
          );
        })}
        {loading &&
          [0, 1, 2].map((i) => (
            <div className="card key-card" key={i}>
              <span className="muted">Loading…</span>
            </div>
          ))}
      </div>
    </section>
  );
}

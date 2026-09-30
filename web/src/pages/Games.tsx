import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Game } from "@heychess/contracts";
import "./Games.css";

const API = "http://localhost:3001";

type Filter = "all" | "win" | "loss" | "draw";

export default function Games() {
  const [games, setGames] = useState<Game[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/api/games?username=aguowisdom&limit=20`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "fetch failed");
      setGames(data.games);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = games.filter((g) => (filter === "all" ? true : g.result === filter));

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>My Games</h1>
          <p>View and analyze your past games.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn-dark">Import Game</button>
          <button type="button" className="btn-light">Filters ▾</button>
        </div>
      </div>

      <div className="card">
        <div className="tabs">
          {(["all", "win", "loss"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "tab active" : "tab"}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? `All (${games.length})` : f === "win" ? "Wins" : "Losses"}
            </button>
          ))}
          <span className="spacer" />
          <span className="muted">Last 30 games ▾</span>
        </div>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading games…</p>}

        <table className="table">
          <thead>
              <tr>
                <th>Result</th>
                <th>Opponent</th>
                <th>Format</th>
                <th>Accuracy</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
          </thead>
          <tbody>
            {filtered.map((g) => (
              <tr key={g.id} onClick={() => navigate(`/games/${encodeURIComponent(g.id)}`, { state: { game: g } })} className="row">
                <td>
                  <span className={`result-pill ${g.result}`}>
                    <span className="result-dot">{g.result === "win" ? "✓" : g.result === "loss" ? "✕" : "="}</span>
                    {g.result === "win" ? "Win" : g.result === "loss" ? "Loss" : "Draw"}
                  </span>
                </td>
                <td>
                  <span className="opp">
                    <span className="opp-avatar">{g.opponent.charAt(0).toUpperCase()}</span>
                    {g.opponent}
                  </span>
                </td>
                <td>{g.timeControl}</td>
                <td>{g.accuracy ?? "—"}</td>
                <td>{new Date(g.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                <td>⋯</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

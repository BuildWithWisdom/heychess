import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Game, PlayerStats } from "@heychess/contracts";
import { gamesCacheKey, getCachedGames, setCachedGames } from "../utils/gamesCache";
import "./Games.css";
import "./Home.css";
import { useChessProfile } from "../lib/profile.ts";

const API = "http://localhost:3001";

const LIMIT = 10;

// Stats change slowly (new games only), so reuse them across page
// switches instead of flashing "—" on every visit. 10 minutes is plenty
// fresh for win rate; accuracy revalidates in the background each visit
// but always paints the cached value first.
const STATS_TTL_MS = 10 * 60 * 1000;
const statsByUser = new Map<string, { stats: PlayerStats; avg: number | null; at: number }>();

export default function Home() {
  // The linked handle comes from the user profile (server-side).
  // null = new user with nothing linked: show empty, fetch nothing.
  const { handle: username, loading: profileLoading } = useChessProfile();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [avgAccuracy, setAvgAccuracy] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      if (profileLoading) return;
      if (!username) {
        setLoading(false);
        return;
      }
      const key = username.toLowerCase();
      // Paint everything cached instantly — no flash on route switches.
      const cached = getCachedGames(gamesCacheKey(username, LIMIT));
      const needsGames = !cached;
      if (cached) setGames(cached);
      const prev = statsByUser.get(key);
      const statsFresh = prev !== undefined && Date.now() - prev.at < STATS_TTL_MS;
      if (prev) {
        setStats(prev.stats);
        setAvgAccuracy(prev.avg);
      }
      setLoading(!cached && !prev);
      setError("");
      try {
        // Win rate barely moves: skip while fresh. Accuracy can change after
        // each analysis, so always revalidate it in the background — the
        // cached value above already covers the paint.
        const statsReq = statsFresh ? null : fetch(`${API}/api/player/stats?username=${username}`);
        const accReq = fetch(`${API}/api/player/accuracy`, { credentials: "include" });
        const gamesReq = needsGames
          ? fetch(`${API}/api/games?limit=${LIMIT}`, { credentials: "include" })
          : null;
        const [sRes, aRes, gRes] = await Promise.all([
          statsReq ?? Promise.resolve(null),
          accReq,
          gamesReq ?? Promise.resolve(null),
        ]);
        let stats = prev?.stats ?? null;
        if (sRes) {
          const sData = await sRes.json();
          if (!sRes.ok) throw new Error(sData.error ?? "stats fetch failed");
          stats = sData as PlayerStats;
          setStats(stats);
        }
        const aData = await (aRes as Response).json();
        const avg = typeof aData.avgAccuracy === "number" ? (aData.avgAccuracy as number) : null;
        setAvgAccuracy(avg);
        if (stats) statsByUser.set(key, { stats, avg, at: statsFresh && prev ? prev.at : Date.now() });
        if (gRes) {
          const gData = await (gRes as Response).json();
          if (!(gRes as Response).ok) throw new Error(gData.error ?? "games fetch failed");
          const sliced = (gData.games as Game[]).slice(0, LIMIT);
          setGames(sliced);
          setCachedGames(gamesCacheKey(username, LIMIT), sliced);
        }
      } catch (e) {
        if (!cached && !prev) setError(e instanceof Error ? e.message : "load failed");
      } finally {
        setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, profileLoading]);

  return (
    <section>
      <h1>Good evening, Wisdom 👋</h1>
      <p className="muted">Here's a quick look at your chess journey.</p>

      {!username && !loading && (
        <p className="muted">
          No games yet. <Link to="/welcome">Import your games</Link> to get started.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Total Games</div>
          <div className="stat-value">{loading ? "—" : stats?.totalGames ?? "—"}</div>
          <div className="stat-sub muted-green">All time · chess.com</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Win Rate</div>
          <div className="stat-value">{loading ? "—" : `${stats?.winRate ?? 0}%`}</div>
          <div className="stat-sub muted-green">
            {stats ? `${stats.wins}W · ${stats.losses}L · ${stats.draws}D` : "—"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Avg. Accuracy</div>
          <div className="stat-value">{loading && avgAccuracy === null ? "—" : avgAccuracy !== null ? `${avgAccuracy}%` : "—"}</div>
          <div className="stat-sub muted-green">
            {loading && avgAccuracy === null
              ? "…"
              : avgAccuracy !== null
                ? "Ours + Chess.com combined"
                : "No games analyzed yet"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">♟ Chess.com</div>
          <div className="stat-value" style={{ fontSize: 15 }}>
            <span className="dot-live" />
            Connected
          </div>
          <div className="stat-sub muted-green">@{username || "—"}</div>
        </div>
      </div>

      <div className="home-grid">
        <div className="card">
          <div className="tabs">
            <strong style={{ fontSize: 13 }}>Recent Games</strong>
            <span className="spacer" />
            <Link to="/games" className="muted">View all</Link>
          </div>
          {loading && <p className="muted">Loading games…</p>}
          <table className="table">
            <thead>
              <tr>
                <th>Result</th>
                <th>Opponent</th>
                <th>Time Control</th>
                <th>Accuracy</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.id}>
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
                  <td>
                    {g.accuracy !== undefined ? (
                      `${g.accuracy}%`
                    ) : (
                      <span className="acc-missing" title="Analyze game to get your accuracy">
                        ?
                      </span>
                    )}
                  </td>
                  <td>{new Date(g.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

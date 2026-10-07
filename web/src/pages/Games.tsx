import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Game } from "@heychess/contracts";
import { getCachedGames, invalidateSliceCaches, isBrowserReload, loadGamesUi, saveGamesUi, setCachedGames } from "../utils/gamesCache";
import "./Games.css";

import { useChessProfile } from "../lib/profile.ts";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const PAGE_SIZE = 20;
// One full lightweight list (no PGNs) per browser session. Tabs and pages
// are computed locally from it — the ONLY refetch paths are a browser
// refresh (cache starts empty) and the Sync button.

type Tab = "all" | "win" | "loss" | "chesscom" | "lichess";

const VALID_TABS: Tab[] = ["all", "win", "loss", "chesscom", "lichess"];

function initialUi(): { tab: Tab; page: number } {
  const saved = loadGamesUi();
  const tab: Tab = saved && (VALID_TABS as string[]).includes(saved.tab) ? (saved.tab as Tab) : "all";
  const page = saved && Number.isFinite(saved.page) && saved.page >= 1 ? Math.floor(saved.page) : 1;
  return { tab, page };
}

export default function Games() {
  // The linked handle comes from the user profile (server-side).
  // null = new user with nothing linked: show empty, fetch nothing.
  const { handle: username, loading: profileLoading } = useChessProfile();
  const fullKey = `full:${username ?? "none"}`;
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [initial] = useState(initialUi);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [page, setPage] = useState(initial.page);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const navigate = useNavigate();

  // Fetch the whole list. Background polls never touch loading so the table
  // never flashes once painted.
  async function fetchFull(opts?: { refresh?: boolean }): Promise<boolean> {
    const q = new URLSearchParams({
      page: "1",
      pageSize: String(PAGE_SIZE),
      full: "1",
      ...(opts?.refresh ? { refresh: "1" } : {}),
    });
    const res = await fetch(`${API}/api/games?${q}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "fetch failed");
    setAllGames(data.games);
    setCachedGames(fullKey, data.games);
    return Boolean(data.syncing);
  }

  // Mount: cached list paints instantly with zero requests. A real browser
  // refresh silently revalidates in the background (no loading flash).
  // Anything else (route/tab/page switches) never fetches.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (profileLoading) return;
      if (!username) {
        setLoading(false);
        return;
      }
      const cached = getCachedGames(fullKey);
      if (cached) {
        setAllGames(cached);
        setLoading(false);
        if (isBrowserReload()) {
          try {
            await fetchFull();
          } catch {
            // Keep the cache on failure.
          }
        }
        return;
      }
      setLoading(true);
      setError("");
      try {
        await fetchFull();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, profileLoading]);

  // Remember where you were, so back-navigation restores tab + page.
  useEffect(() => {
    saveGamesUi({ tab, page });
  }, [tab, page]);

  // Force a fresh chess.com pull, bypassing the server's sync cache.
  // Lichess has no backend integration yet, so its row is a placeholder.
  async function syncChessCom() {
    if (!username) return;
    setSyncingNow(true);
    setSyncMsg("");
    setSyncOpen(false);
    try {
      let polls = 0;
      let stillSyncing = await fetchFull({ refresh: true });
      setSyncing(stillSyncing);
      while (stillSyncing && polls < 20) {
        polls++;
        await new Promise((r) => setTimeout(r, 4000));
        try {
          stillSyncing = await fetchFull();
        } catch {
          break;
        }
        setSyncing(stillSyncing);
        if (!stillSyncing) break;
      }
      setPage(1);
      setSyncMsg("Synced just now");
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      // The sync added rows server-side. Home's latest-N slice cache would
      // otherwise keep painting the pre-sync 10 forever (it never expires),
      // so drop it — the next Home visit refetches the true latest games.
      // Runs on failure too: a partial sync may still have added rows.
      invalidateSliceCaches(username);
      setSyncingNow(false);
    }
  }

  function pickTab(t: Tab) {
    setTab(t);
    setPage(1);
  }

  const counts = {
    all: allGames.length,
    win: allGames.filter((g) => g.result === "win").length,
    loss: allGames.filter((g) => g.result === "loss").length,
    chesscom: allGames.filter((g) => g.source === "chesscom").length,
    lichess: allGames.filter((g) => g.source === "lichess").length,
  };

  const filtered = allGames.filter((g) => {
    if (tab === "win") return g.result === "win";
    if (tab === "loss") return g.result === "loss";
    if (tab === "chesscom") return g.source === "chesscom";
    if (tab === "lichess") return g.source === "lichess";
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const end = Math.min(safePage * PAGE_SIZE, filtered.length);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>My Games</h1>
          <p>
            {username
              ? "View and analyze your past games."
              : "No games yet — import your games to get started."}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn-dark">Import Game</button>
          <div className="sync-wrap">
            <button
              type="button"
              className="btn-light"
              onClick={() => setSyncOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={syncOpen}
            >
              {syncingNow ? "Syncing…" : "Sync ▾"}
            </button>
            {syncOpen && (
              <div className="sync-menu" role="menu">
                <button
                  type="button"
                  className="sync-item"
                  role="menuitem"
                  disabled={syncingNow}
                  onClick={syncChessCom}
                >
                  Sync Chess.com
                </button>
                <button
                  type="button"
                  className="sync-item"
                  role="menuitem"
                  title="Lichess sync is not connected yet"
                  onClick={() => {
                    setSyncMsg("Lichess is not connected yet");
                    setSyncOpen(false);
                  }}
                >
                  Sync Lichess
                </button>
              </div>
            )}
          </div>
          {syncMsg && <span className="muted">{syncMsg}</span>}
        </div>
      </div>

      <div className="card">
        <div className="tabs">
          <button type="button" className={tab === "all" ? "tab active" : "tab"} onClick={() => pickTab("all")}>
            All ({loading && allGames.length === 0 ? "…" : counts.all})
          </button>
          <button type="button" className={tab === "win" ? "tab active" : "tab"} onClick={() => pickTab("win")}>
            Wins
          </button>
          <button type="button" className={tab === "loss" ? "tab active" : "tab"} onClick={() => pickTab("loss")}>
            Losses
          </button>
          <button type="button" className={tab === "chesscom" ? "tab active" : "tab"} onClick={() => pickTab("chesscom")}>
            Chess.com ({counts.chesscom})
          </button>
          <button type="button" className={tab === "lichess" ? "tab active" : "tab"} onClick={() => pickTab("lichess")}>
            Lichess ({counts.lichess})
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading games…</p>}
        {syncing && !loading && <p className="muted">Syncing all games in the background…</p>}

        <table className="table">
          <thead>
              <tr>
                <th>Result</th>
                <th>Opponent</th>
                <th>Format</th>
                <th>Accuracy</th>
                <th>Date</th>
              </tr>
          </thead>
          <tbody>
            {visible.map((g) => (
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
        {tab === "lichess" && visible.length === 0 && !loading && (
          <p className="muted">No Lichess games yet — Lichess is not connected.</p>
        )}

        <div className="pager-bar">
          <span className="muted">
            {filtered.length === 0 ? "No games" : `Showing ${start}–${end} of ${filtered.length}`}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn-light pager"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ‹ Prev
          </button>
          <span className="muted">
            {safePage} / {pageCount}
          </span>
          <button
            type="button"
            className="btn-light pager"
            disabled={safePage >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            Next ›
          </button>
        </div>
      </div>
    </section>
  );
}

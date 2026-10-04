import type { Game } from "@heychess/contracts";

// Durable list cache. Rules:
// - Survives route switches, hot-reloads, and browser refreshes (in-memory
//   Maps die on all three — that was the empty-list-on-back bug).
// - Entries are replaced ONLY by a fresh fetch (browser refresh revalidates
//   silently, Sync button refetches). Tabs/pages never fetch.
// - There is deliberately NO time expiry.
const LS_GAMES = "heychess:games:cache:v1";
const LS_UI = "heychess:games:ui:v1";

function readGamesStore(): Record<string, Game[]> {
  try {
    const raw = localStorage.getItem(LS_GAMES);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Game[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGamesStore(all: Record<string, Game[]>) {
  try {
    localStorage.setItem(LS_GAMES, JSON.stringify(all));
  } catch {
    // Quota or privacy mode: fall back to no cache.
  }
}

export function gamesCacheKey(username: string, limit: number) {
  return `${username.toLowerCase()}:${limit}`;
}

export function getCachedGames(key: string): Game[] | null {
  return readGamesStore()[key] ?? null;
}

export function setCachedGames(key: string, games: Game[]) {
  const all = readGamesStore();
  all[key] = games;
  writeGamesStore(all);
}

// Drop all cached game lists (e.g. after linking a new handle or signing
// up) so the next user never sees the previous user's rows.
export function clearGamesCache() {
  try {
    localStorage.removeItem(LS_GAMES);
  } catch {
    // ignore
  }
}

// Write-through from GameDetail after analysis lands, so going back to the
// list shows the new accuracy instantly (server confirms it later).
export function updateCachedAccuracy(gameId: string, accuracy: number) {
  const all = readGamesStore();
  let touched = false;
  for (const [key, games] of Object.entries(all)) {
    if (!games.some((g) => g.id === gameId)) continue;
    all[key] = games.map((g) => (g.id === gameId ? { ...g, accuracy } : g));
    touched = true;
  }
  if (touched) writeGamesStore(all);
}

// Last tab/page, so back-navigation restores where you were.
export type GamesUi = { tab: string; page: number };

export function loadGamesUi(): GamesUi | null {
  try {
    const raw = localStorage.getItem(LS_UI);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GamesUi;
    if (typeof parsed?.page !== "number" || typeof parsed?.tab !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveGamesUi(ui: GamesUi) {
  try {
    localStorage.setItem(LS_UI, JSON.stringify(ui));
  } catch {
    // ignore
  }
}

// True only on a real browser refresh/reload (not SPA navigation).
export function isBrowserReload(): boolean {
  try {
    const entries = performance.getEntriesByType("navigation");
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload";
  } catch {
    return false;
  }
}

import { useCallback, useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

// Session-long cache for the linked handle. The handle only changes when
// the user links a new account, so there is no expiry timer — every page
// mount reuses the same value instead of flashing the empty state.
// (Stats are different: they change as you play, so Home caches those
// separately with a short TTL.)
let cachedHandle: string | null | undefined = undefined;
let handleFlight: Promise<string | null> | null = null;

async function fetchHandleOnce(): Promise<string | null> {
  if (cachedHandle !== undefined) return cachedHandle;
  if (!handleFlight) {
    handleFlight = (async () => {
      try {
        const res = await fetch(`${API}/api/profile`, { credentials: "include" });
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data.chessComUsername === "string" && data.chessComUsername
          ? data.chessComUsername
          : null;
      } catch {
        return null;
      }
    })();
  }
  const h = await handleFlight;
  cachedHandle = h;
  handleFlight = null;
  return h;
}

// The linked chess.com handle lives on the user profile (server-side).
// null = new user with nothing linked yet.
export function useChessProfile() {
  const [handle, setHandle] = useState<string | null>(() =>
    cachedHandle !== undefined ? cachedHandle : null
  );
  const [loading, setLoading] = useState(() => cachedHandle === undefined);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      handleFlight = null;
      cachedHandle = undefined;
      const h = await fetchHandleOnce();
      setHandle(h);
      return h;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    if (cachedHandle !== undefined) {
      setHandle(cachedHandle);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchHandleOnce()
      .then((h) => {
        if (live) setHandle(h);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return { handle, loading, linked: handle !== null, refresh };
}

// Link (or re-link) the chess.com handle to the current user's profile.
export async function linkChessProfile(handle: string): Promise<string> {
  const h = handle.trim().toLowerCase();
  const res = await fetch(`${API}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ chessComUsername: h }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "could not link account");
  cachedHandle = h;
  return h;
}

// One-off read (login routing) without the hook.
export async function fetchLinkedHandle(): Promise<string | null> {
  return fetchHandleOnce();
}

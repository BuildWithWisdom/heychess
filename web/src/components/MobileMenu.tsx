import { useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth-client.ts";
import { useChessProfile } from "../lib/profile.ts";
import chesscomLogo from "../assets/chessdotcom.png";
import lichessLogo from "../assets/lichess.png";
import "./MobileMenu.css";

const navItems = [
  { to: "/", label: "Home", icon: "⌂", end: true },
  { to: "/games", label: "Games", icon: "♟" },
  { to: "/insights", label: "Insights", icon: "◈" },
  { to: "/progress", label: "Progress", icon: "↗" },
];

export default function MobileMenu({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { handle } = useChessProfile();

  const displayName =
    (session?.user?.name ?? "").trim() ||
    (session?.user?.email?.split("@")[0] ?? "") ||
    "Wisdom";
  const initial = displayName.charAt(0).toUpperCase() || "W";

  // Close the drawer on every route change.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Escape to close + lock body scroll while open (drawer overlays, never pushes).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  async function handleLogout() {
    try {
      await authClient.signOut();
    } finally {
      onClose();
      window.location.href = "/login";
    }
  }

  function go(path: string) {
    onClose();
    navigate(path);
  }

  return (
    <>
      <header className="mobile-header">
        <span className="mobile-brand">
          <span className="mobile-brand-mark">♜</span>
          HEYCHESS
        </span>
        <button
          type="button"
          className="hamburger"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="mobile-drawer"
          onClick={onOpen}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      <div
        className={open ? "drawer-backdrop open" : "drawer-backdrop"}
        aria-hidden={!open}
        onClick={onClose}
      />
      <aside
        id="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={open ? "drawer open" : "drawer"}
      >
        <div className="drawer-profile">
          <span className="drawer-avatar">{initial}</span>
          <div className="drawer-who">
            <strong>{displayName}</strong>
            <small>Free Plan</small>
          </div>
          <button
            type="button"
            className="drawer-close"
            aria-label="Close menu"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <nav className="drawer-nav" aria-label="Primary">
          {navItems.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              onClick={onClose}
              className={({ isActive }) =>
                isActive ? "drawer-link active" : "drawer-link"
              }
            >
              <span className="drawer-link-icon">{i.icon}</span>
              {i.label}
              <span className="drawer-link-chev">›</span>
            </NavLink>
          ))}
        </nav>

        <div className="drawer-sep" />

        <div className="drawer-group" aria-label="Account">
          <button type="button" className="drawer-link" onClick={() => go("/progress")}>
            <span className="drawer-link-icon">○</span>
            Profile
            <span className="drawer-link-chev">›</span>
          </button>
          <button type="button" className="drawer-link" onClick={() => go("/welcome")}>
            <img src={chesscomLogo} alt="" className="drawer-logo" />
            <span className="drawer-link-text">
              Chess.com
              <small className={handle ? "ok" : "dim"}>
                {handle ? "Connected" : "Not connected"}
              </small>
            </span>
            <span className="drawer-link-chev">›</span>
          </button>
          <button
            type="button"
            className="drawer-link"
            title="Lichess is not connected yet"
            onClick={onClose}
          >
            <img src={lichessLogo} alt="" className="drawer-logo" />
            <span className="drawer-link-text">
              Lichess
              <small className="dim">Not connected</small>
            </span>
            <span className="drawer-link-chev">›</span>
          </button>
          <button type="button" className="drawer-link" onClick={onClose}>
            <span className="drawer-link-icon">⚙</span>
            Settings
            <span className="drawer-link-chev">›</span>
          </button>
          <button type="button" className="drawer-link" onClick={onClose}>
            <span className="drawer-link-icon">?</span>
            Help &amp; Support
            <span className="drawer-link-chev">›</span>
          </button>
          <button type="button" className="drawer-link" onClick={handleLogout}>
            <span className="drawer-link-icon">↩</span>
            Log Out
          </button>
        </div>

        <div className="drawer-quote">
          <p>“Small steps, consistent practice, big results.”</p>
          <small>– HeyChess</small>
        </div>
      </aside>
    </>
  );
}

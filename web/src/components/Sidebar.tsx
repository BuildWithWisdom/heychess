import { NavLink } from "react-router-dom";
import { authClient } from "../lib/auth-client.ts";
import { getDisplayName } from "../lib/profile.ts";
import "./Sidebar.css";

const items = [
  { to: "/", label: "Home", icon: "⌂", end: true },
  { to: "/games", label: "Games", icon: "♟" },
  { to: "/insights", label: "Insights", icon: "◈" },
  { to: "/progress", label: "Progress", icon: "↗" },
];

export default function Sidebar() {
  const { data: session } = authClient.useSession();
  const displayName = getDisplayName(session);
  const initial = displayName.charAt(0).toUpperCase() || "?";
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="sidebar-mark">♜</span>
        <span>HEYCHESS</span>
      </div>
      <nav className="sidebar-nav">
        {items.map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            end={i.end}
            className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
          >
            <span className="nav-icon">{i.icon}</span>
            {i.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-user">
        <span className="avatar">{initial}</span>
        <div>
          <strong>{displayName}</strong>
          <small>Free Plan</small>
        </div>
        <span className="gear">⚙</span>
      </div>
    </aside>
  );
}

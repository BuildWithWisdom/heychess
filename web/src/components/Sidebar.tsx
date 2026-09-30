import { NavLink } from "react-router-dom";
import "./Sidebar.css";

const items = [
  { to: "/", label: "Home", icon: "⌂", end: true },
  { to: "/games", label: "Games", icon: "♟" },
  { to: "/insights", label: "Insights", icon: "◈" },
  { to: "/progress", label: "Progress", icon: "↗" },
];

export default function Sidebar() {
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
        <span className="avatar">W</span>
        <div>
          <strong>Wisdom</strong>
          <small>Free Plan</small>
        </div>
        <span className="gear">⚙</span>
      </div>
    </aside>
  );
}

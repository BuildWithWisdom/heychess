import { useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar.tsx";
import MobileMenu from "./components/MobileMenu.tsx";
import Home from "./pages/Home.tsx";
import Games from "./pages/Games.tsx";
import GameDetail from "./pages/GameDetail.tsx";
import Insights from "./pages/Insights.tsx";
import Progress from "./pages/Progress.tsx";
import Login from "./pages/Login.tsx";
import Onboarding from "./pages/Onboarding.tsx";
import { authClient } from "./lib/auth-client.ts";
import "./App.css";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  if (isPending) return <div className="app-shell">Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app-shell">
      <RequireAuth>
        <Sidebar />
        <MobileMenu
          open={menuOpen}
          onOpen={() => setMenuOpen(true)}
          onClose={() => setMenuOpen(false)}
        />
        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/games" element={<Games />} />
            <Route path="/games/:id" element={<GameDetail />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/progress" element={<Progress />} />
          </Routes>
        </main>
      </RequireAuth>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/welcome"
        element={
          <RequireAuth>
            <Onboarding />
          </RequireAuth>
        }
      />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}

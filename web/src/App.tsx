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
import { useChessProfile } from "./lib/profile.ts";
import "./App.css";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();
  if (isPending) return <div className="app-shell">Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// Reverse of RequireAuth: logged-in users hitting /login go home.
function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <div className="app-shell">Loading…</div>;
  if (session) return <Navigate to="/" replace />;
  return <>{children}</>;
}

// /welcome is onboarding for users with nothing linked yet. Logged-in
// users who already linked a chess account bounce home instead.
function RequireOnboarding({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const { linked, loading: profileLoading } = useChessProfile();
  const location = useLocation();
  if (isPending) return <div className="app-shell">Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  if (profileLoading) return <div className="app-shell">Loading…</div>;
  if (linked) return <Navigate to="/" replace />;
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
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <Login />
          </RedirectIfAuthed>
        }
      />
      <Route
        path="/welcome"
        element={
          <RequireOnboarding>
            <Onboarding />
          </RequireOnboarding>
        }
      />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}

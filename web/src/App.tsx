import { Route, Routes } from "react-router-dom";
import Sidebar from "./components/Sidebar.tsx";
import Home from "./pages/Home.tsx";
import Games from "./pages/Games.tsx";
import GameDetail from "./pages/GameDetail.tsx";
import Insights from "./pages/Insights.tsx";
import Progress from "./pages/Progress.tsx";
import "./App.css";

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/:id" element={<GameDetail />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/progress" element={<Progress />} />
        </Routes>
      </main>
    </div>
  );
}

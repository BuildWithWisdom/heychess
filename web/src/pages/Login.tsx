import { useState } from "react";
import signupImg from "../assets/signup.png";
import { authClient } from "../lib/auth-client.ts";
import { fetchLinkedHandle } from "../lib/profile.ts";
import { clearGamesCache } from "../utils/gamesCache.ts";
import "./Login.css";

export default function Login() {
  const [tab, setTab] = useState<"login" | "signup">("login");
  // Mobile only: TEMPO mock is a splash first (Get Started / Log In),
  // the form appears after a tap. Desktop always shows the form.
  const [entered, setEntered] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (tab === "signup") {
        const name = email.split("@")[0] || email;
        const { error } = await authClient.signUp.email({
          email: email.trim(),
          password,
          name,
        });
        if (error) throw new Error(error.message ?? "Sign up failed");
        // Fresh account: drop any games cached by a previous
        // browser user so the new profile starts with no data.
        // (Handles live on the user profile server-side — nothing to clear.)
        clearGamesCache();
        // Refresh the client session BEFORE leaving: otherwise RequireAuth
        // still sees "no session" and bounces the new user back to /login.
        // Hard nav (not SPA) so the welcome page loads with a valid session.
        await authClient.getSession();
        window.location.href = "/welcome";
        return;
      } else {
        const { error } = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (error) throw new Error(error.message ?? "Log in failed");
        await authClient.getSession();
        // Returning user with no linked handle still needs onboarding.
        const linked = await fetchLinkedHandle();
        window.location.href = linked ? "/" : "/welcome";
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  function enter(next: "login" | "signup") {
    setTab(next);
    setError(null);
    setEntered(true);
    requestAnimationFrame(() => {
      document.getElementById("login-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <div className={entered ? "login-page entered" : "login-page"}>
      <div className="login-left">
        <div className="login-brand">
          <span className="login-brand-mark">♜</span>
          <span className="login-brand-word">HEYCHESS</span>
        </div>

        <div className="login-hero-copy">
          <h1>
            Better analysis.
            <br />
            Faster improvement.
          </h1>
          <p>
            Your personal chess analyst. Understand your games, find patterns,
            and get better with every move.
          </p>
        </div>

        <div className="login-hero-img-wrap">
          <img
            className="login-hero-img"
            src={signupImg}
            alt="Black king and white pawn"
          />
        </div>

        <div className="login-mobile-cta">
          <button type="button" className="login-getstarted" onClick={() => enter("signup")}>
            Get Started
          </button>
          <button type="button" className="login-login-link" onClick={() => enter("login")}>
            Log In
          </button>
        </div>
      </div>

      {entered && (
        <button
          type="button"
          aria-label="Back"
          className="login-sheet-backdrop"
          onClick={() => setEntered(false)}
        />
      )}
      <div className="login-right">
        <div className="login-card" id="login-card">
          <div className="login-tabs" role="tablist" aria-label="Auth">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "login"}
              className={tab === "login" ? "login-tab active" : "login-tab"}
              onClick={() => {
                setTab("login");
                setError(null);
              }}
            >
              Log In
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "signup"}
              className={tab === "signup" ? "login-tab active" : "login-tab"}
              onClick={() => {
                setTab("signup");
                setError(null);
              }}
            >
              Sign Up
            </button>
          </div>

          <form className="login-form" onSubmit={onSubmit}>
            <label className="login-label" htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              className="login-input"
              type="email"
              placeholder="you@example.com"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <label className="login-label" htmlFor="login-password">
              Password
            </label>
            <div className="login-pw-wrap">
              <input
                id="login-password"
                className="login-input login-input-pw"
                type={showPw ? "text" : "password"}
                placeholder={
                  tab === "login"
                    ? "Enter your password"
                    : "8+ characters"
                }
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
              <button
                type="button"
                className="login-pw-toggle"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((v) => !v)}
              >
                {showPw ? "◉" : "◎"}
              </button>
            </div>

            {error && (
              <p className="login-error" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="login-submit" disabled={pending}>
              {pending
                ? "Please wait…"
                : tab === "login"
                  ? "Log In"
                  : "Sign Up"}
            </button>
          </form>

          {tab === "login" && (
            <button type="button" className="login-forgot">
              Forgot password?
            </button>
          )}
          {tab === "signup" && <div className="login-forgot-spacer" />}

          <div className="login-or">
            <span />
            <em>or</em>
            <span />
          </div>

          <div className="login-oauth">
            <button type="button" className="login-oauth-btn" disabled title="Coming soon">
              <span className="login-oauth-icon">♟</span>
              Continue with Chess.com
            </button>
            <button type="button" className="login-oauth-btn" disabled title="Coming soon">
              <span className="login-oauth-icon">◔</span>
              Continue with Lichess
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth-provider";
import { supabase } from "../supabase-browser";

export default function LoginPage() {
  const { ready, session, configured } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function returnPath() {
    const requested = new URLSearchParams(window.location.search).get("next");
    if (!requested) return "/";
    try {
      const destination = new URL(requested, window.location.origin);
      if (destination.origin !== window.location.origin) return "/";
      return `${destination.pathname}${destination.search}${destination.hash}`;
    } catch {
      return "/";
    }
  }

  useEffect(() => {
    if (ready && session) router.replace(returnPath());
    if (new URLSearchParams(window.location.search).get("expired") === "1") {
      setMessage("Your session expired. Please sign in again.");
    }
  }, [ready, router, session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "signup") {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (authError) throw authError;
        if (data.session) router.replace(returnPath());
        else setMessage("Check your email to confirm your account, then sign in.");
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (authError) throw authError;
        router.replace(returnPath());
      }
    } catch {
      setError("Authentication failed. Check your details and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content-shell">
      <nav className="content-nav" aria-label="Primary navigation">
        <Link className="content-brand" href="/discover">
          ✦ MAX
        </Link>
        <div className="content-nav-links">
          <Link href="/discover">Discover</Link>
        </div>
      </nav>
      <section className="content-hero">
        <p className="content-eyebrow">YOUR PRIVATE RESEARCH WORKSPACE</p>
        <h1>{mode === "signin" ? "Sign in to MAX" : "Create your MAX account"}</h1>
        <p>Your research history stays private to your account.</p>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        {!configured ? (
          <p className="content-state error" role="alert">
            Sign-in is not configured. Set NEXT_PUBLIC_SUPABASE_URL and
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY for the web app.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {message && <p role="status">{message}</p>}
            {error && (
              <p role="alert" className="content-state error">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
            <button
              type="button"
              className="login-mode-toggle"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError("");
                setMessage("");
              }}
            >
              {mode === "signin" ? "Create an account" : "Already have an account? Sign in"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

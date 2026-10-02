"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase-browser";

interface AuthContextValue {
  ready: boolean;
  session: Session | null;
  configured: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const client = supabase;
    if (!client) {
      setReady(true);
      return;
    }

    let active = true;
    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setReady(true);
    });
    void client.auth
      .getSession()
      .then(({ data: current }) => {
        if (!active) return;
        setSession(current.session);
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        setSession(null);
        setReady(true);
      });

    const handleExpired = () => {
      void client.auth.signOut().finally(() => router.replace("/login?expired=1"));
    };
    window.addEventListener("max:auth-expired", handleExpired);
    return () => {
      active = false;
      data.subscription.unsubscribe();
      window.removeEventListener("max:auth-expired", handleExpired);
    };
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      session,
      configured: Boolean(supabase),
      signOut: async () => {
        if (!supabase) return;
        const { error } = await supabase.auth.signOut();
        if (error) throw new Error("Could not sign out right now.");
      },
    }),
    [ready, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, RecentItem, SearchAvailability } from "./components/Sidebar";
import { Header } from "./components/Header";
import { HeroLanding } from "./components/HeroLanding";
import { ChatComposer } from "./components/ChatComposer";
import {
  ResearchArtifact,
  ResearchMessageItem,
  SessionData,
  InterpretationData,
} from "./components/ResearchArtifact";
import { useAuth } from "./auth-provider";
import { authenticatedFetch } from "./supabase-browser";
import { getApiBaseUrl } from "./api-url";

const API = getApiBaseUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);

export default function Home() {
  const { ready: authReady, session, signOut } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<ResearchMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [deepResearch, setDeepResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recentSearches, setRecentSearches] = useState<RecentItem[]>([]);
  const [searchAvailability, setSearchAvailability] = useState<SearchAvailability>("checking");

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (authReady && !session) router.replace("/login");
  }, [authReady, router, session]);

  useEffect(() => {
    if (!session) return;
    try {
      const savedRecent = localStorage.getItem(`max_recent_inquiries:${session.user.id}`);
      setRecentSearches(savedRecent ? JSON.parse(savedRecent) : []);
    } catch {
      setRecentSearches([]);
    }
    setMessages([]);
    setActiveSessionId(null);
    setBusy(false);
  }, [session?.user.id]);

  // Initialize service worker, theme, and saved recent searches
  useEffect(() => {
    const readinessController = new AbortController();
    void fetch(`${API}/ready`, {
      cache: "no-store",
      signal: readinessController.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Readiness request failed (${response.status})`);
        return (await response.json()) as { search?: string };
      })
      .then((readiness) =>
        setSearchAvailability(readiness.search === "configured" ? "ready" : "missing"),
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setSearchAvailability("offline");
      });

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch(() => undefined);
    }

    // Theme initialization
    const savedTheme = localStorage.getItem("max_theme") as "light" | "dark" | null;
    const preferredTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    const initialTheme = savedTheme || preferredTheme || "dark";
    setTheme(initialTheme);
    document.documentElement.setAttribute("data-theme", initialTheme);

    // Initial sidebar responsive state (auto-collapse on small screens)
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }

    return () => readinessController.abort();
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("max_theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  }

  function saveRecentInquiry(title: string, deep: boolean) {
    setRecentSearches((prev) => {
      const filtered = prev.filter((item) => item.title.toLowerCase() !== title.toLowerCase());
      const updated: RecentItem[] = [
        {
          id: `inq-${Date.now()}`,
          title: title.length > 60 ? title.slice(0, 57) + "..." : title,
          timestamp: Date.now(),
          deepResearch: deep,
        },
        ...filtered,
      ].slice(0, 20); // Keep last 20
      try {
        if (session) {
          localStorage.setItem(`max_recent_inquiries:${session.user.id}`, JSON.stringify(updated));
        }
      } catch {
        // Ignored
      }
      return updated;
    });
  }

  function handleClearHistory() {
    setRecentSearches([]);
    try {
      if (session) localStorage.removeItem(`max_recent_inquiries:${session.user.id}`);
    } catch {
      // Ignored
    }
  }

  function handleNewInvestigation() {
    if (busy) {
      handleCancel();
    }
    setMessages([]);
    setInput("");
    setActiveSessionId(null);
  }

  // Smooth scroll when conversation updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Authenticated polling keeps private session state behind the bearer-token guard.
  useEffect(() => {
    if (!activeSessionId || !session) return;
    const pollController = new AbortController();
    let stopped = false;
    let pollInFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    function applySession(session: SessionData) {
      updateSessionInMessages(session);
      if (["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(session.status)) {
        setActiveSessionId(null);
        setBusy(false);
        return true;
      }
      return false;
    }

    async function pollSession() {
      if (stopped || pollInFlight) return;
      pollInFlight = true;
      try {
        const response = await authenticatedFetch(`${API}/api/research/${activeSessionId}`, {
          signal: pollController.signal,
        });
        if (!response.ok) throw new Error(`Research status returned HTTP ${response.status}`);
        const session = (await response.json()) as SessionData;
        applySession(session);
      } catch {
        // Keep polling after transient failures; the session may still be running.
      } finally {
        pollInFlight = false;
      }
    }

    void pollSession();
    pollTimer = setInterval(() => void pollSession(), 2000);

    return () => {
      stopped = true;
      pollController.abort();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [activeSessionId, session?.user.id]);

  function updateSessionInMessages(updated: SessionData) {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.session?.id === updated.id
          ? {
              ...msg,
              session: updated,
              text: updated.answer || msg.text,
              busy: !["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(
                updated.status,
              ),
            }
          : msg,
      ),
    );
  }

  async function handleSend(customText?: string, overrideDeep?: boolean) {
    const textToSend = (customText ?? input).trim();
    if (!textToSend || busy) return;

    const useDeep = overrideDeep !== undefined ? overrideDeep : deepResearch;
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `max-${Date.now()}`;

    // Add to recent searches
    saveRecentInquiry(textToSend, useDeep);

    const userMsg: ResearchMessageItem = {
      id: userMessageId,
      sender: "user",
      text: textToSend,
      deepResearch: useDeep,
    };

    const assistantMsg: ResearchMessageItem = {
      id: assistantMessageId,
      sender: "max",
      userPrompt: textToSend,
      busy: true,
      deepResearch: useDeep,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await authenticatedFetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: textToSend, deepResearch: useDeep }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MAX API returned HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        route: string;
        answer?: string;
        session?: SessionData;
        researchId?: string;
        interpretation?: InterpretationData;
      };

      if (payload.route === "direct" || payload.answer) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  route: payload.route,
                  text: payload.answer || "",
                  session: payload.session,
                  interpretation: payload.interpretation,
                  busy: false,
                }
              : msg,
          ),
        );
        setBusy(false);
      } else {
        const sessionId = payload.researchId || payload.session?.id;
        if (sessionId) {
          setActiveSessionId(sessionId);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    route: payload.route,
                    session: payload.session,
                    interpretation: payload.interpretation,
                    busy: true,
                  }
                : msg,
            ),
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  text: (msg.text ? msg.text + "\n\n" : "") + "[Investigation stopped by user]",
                  busy: false,
                }
              : msg,
          ),
        );
      } else {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  error: err instanceof Error ? err.message : "Failed to connect to MAX",
                  busy: false,
                }
              : msg,
          ),
        );
      }
      setBusy(false);
    } finally {
      abortControllerRef.current = null;
    }
  }

  async function handleCancel(sessionId?: string) {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const idToCancel = sessionId || activeSessionId;
    if (idToCancel) {
      try {
        await authenticatedFetch(`${API}/api/research/${idToCancel}/cancel`, { method: "POST" });
      } catch {
        // Ignored
      }
    }

    setActiveSessionId(null);
    setBusy(false);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.busy || (idToCancel && msg.session?.id === idToCancel)
          ? {
              ...msg,
              busy: false,
              text: (msg.text ? msg.text + "\n\n" : "") + "[Investigation stopped by user]",
            }
          : msg,
      ),
    );
  }

  async function handleClarify(sessionId: string, answerText: string) {
    if (!answerText.trim()) return;
    try {
      setBusy(true);
      await authenticatedFetch(`${API}/api/research/${sessionId}/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: answerText }),
      });
      setActiveSessionId(sessionId);
    } catch {
      setBusy(false);
    }
  }

  // Active inquiry title for header breadcrumb
  const firstUserMessage = messages.find((m) => m.sender === "user")?.text;
  const activeTitle = firstUserMessage
    ? firstUserMessage.length > 40
      ? firstUserMessage.slice(0, 38) + "..."
      : firstUserMessage
    : undefined;

  if (!authReady || !session) {
    return (
      <main className="content-shell">
        <div className="content-state" role="status">
          {authReady ? "Opening sign in…" : "Restoring your MAX session…"}
        </div>
      </main>
    );
  }

  return (
    <div className="research-workspace-layout">
      {/* Persistent / Responsive Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        recentSearches={recentSearches}
        onSelectRecent={(item) => handleSend(item.title, item.deepResearch)}
        onNewInvestigation={handleNewInvestigation}
        onClearHistory={handleClearHistory}
        theme={theme}
        searchAvailability={searchAvailability}
        onToggleTheme={toggleTheme}
      />

      {/* Main Research Canvas */}
      <div className={`workspace-main ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"}`}>
        <Header
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          activeTitle={activeTitle}
          theme={theme}
          onToggleTheme={toggleTheme}
          onNewInvestigation={handleNewInvestigation}
          userEmail={session.user.email}
          onSignOut={async () => {
            await signOut();
            router.replace("/login");
          }}
        />

        <main className="workspace-scroll-area">
          {messages.length === 0 ? (
            <HeroLanding onSelectPrompt={(text, deep) => handleSend(text, deep)} />
          ) : (
            <div className="investigation-stream">
              {messages.map((item) =>
                item.sender === "user" ? (
                  <div key={item.id} className="directive-entry">
                    <div className="directive-meta">
                      <span className="directive-badge">RESEARCH INQUIRY</span>
                      {item.deepResearch && (
                        <span className="directive-deep-tag">✦ Deep Research Active</span>
                      )}
                    </div>
                    <h3 className="directive-text">{item.text}</h3>
                  </div>
                ) : (
                  <ResearchArtifact
                    key={item.id}
                    item={item}
                    onCancel={() => handleCancel(item.session?.id)}
                    onClarify={(ans) => item.session && handleClarify(item.session.id, ans)}
                    onRetry={() =>
                      item.userPrompt && void handleSend(item.userPrompt, item.deepResearch)
                    }
                  />
                ),
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </main>

        {/* Fixed Floating Bottom Composer */}
        <ChatComposer
          input={input}
          onChangeInput={setInput}
          onSubmit={() => void handleSend()}
          onStop={() => void handleCancel()}
          deepResearch={deepResearch}
          onToggleDeepResearch={() => setDeepResearch(!deepResearch)}
          isBusy={busy}
        />
      </div>
    </div>
  );
}

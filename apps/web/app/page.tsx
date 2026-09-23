"use client";

import { useEffect, useRef, useState } from "react";
import { Sidebar, RecentItem } from "./components/Sidebar";
import { Header } from "./components/Header";
import { HeroLanding } from "./components/HeroLanding";
import { ChatComposer } from "./components/ChatComposer";
import {
  ResearchArtifact,
  ResearchMessageItem,
  SessionData,
  InterpretationData,
} from "./components/ResearchArtifact";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function Home() {
  const [messages, setMessages] = useState<ResearchMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [deepResearch, setDeepResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recentSearches, setRecentSearches] = useState<RecentItem[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Initialize service worker, theme, and saved recent searches
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js");
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

    // Load recent investigations
    try {
      const savedRecent = localStorage.getItem("max_recent_inquiries");
      if (savedRecent) {
        setRecentSearches(JSON.parse(savedRecent));
      }
    } catch {
      // Ignored
    }
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
        localStorage.setItem("max_recent_inquiries", JSON.stringify(updated));
      } catch {
        // Ignored
      }
      return updated;
    });
  }

  function handleClearHistory() {
    setRecentSearches([]);
    try {
      localStorage.removeItem("max_recent_inquiries");
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

  // Server-Sent Events subscription for active research session
  useEffect(() => {
    if (!activeSessionId) return;
    const events = new EventSource(`${API}/api/research/${activeSessionId}/events`);

    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { session?: SessionData };
        if (payload.session) {
          updateSessionInMessages(payload.session);
          if (
            ["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(
              payload.session.status,
            )
          ) {
            setActiveSessionId(null);
            setBusy(false);
          }
        }
      } catch {
        // Fallback polling on parse failure
        fetch(`${API}/api/research/${activeSessionId}`)
          .then((r) => r.json())
          .then((s: SessionData) => {
            updateSessionInMessages(s);
            if (["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(s.status)) {
              setActiveSessionId(null);
              setBusy(false);
            }
          });
      }
    };

    events.onerror = () => {
      events.close();
    };

    return () => events.close();
  }, [activeSessionId]);

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
      const response = await fetch(`${API}/api/chat`, {
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
        await fetch(`${API}/api/research/${idToCancel}/cancel`, { method: "POST" });
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
      await fetch(`${API}/api/research/${sessionId}/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: answerText }),
      });
      setActiveSessionId(sessionId);
    } catch (e) {
      console.error(e);
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

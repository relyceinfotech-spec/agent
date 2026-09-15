"use client";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type Source = {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  content?: string;
  fetchError?: string;
  quality: { overall: number; relevance: number; authority: number; freshness: number };
};

type LanguageProfile = {
  detected: string;
  name: string;
  respondIn: string;
};

type Interpretation = {
  normalizedQuestion: string;
  intent: string;
  entities: string[];
  topic: string;
  timeframe?: string;
  dimensions: string[];
  corrections: Array<{ from: string; to: string; confidence: number }>;
  ambiguityScore: number;
  ambiguityReasons: string[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  language?: LanguageProfile;
  formatPreference?: string;
};

type Claim = {
  id: string;
  text: string;
  evidence: string;
  confidence: number;
  verification?: {
    verdict: "supported" | "contradicted" | "uncertain" | "unavailable";
    rationale?: string;
  };
};

type Session = {
  id: string;
  question: string;
  mode: "quick" | "deep";
  status: string;
  answer?: string;
  error?: string;
  sources: Source[];
  claims: Claim[];
  conflicts?: Array<{ id: string; description: string; status: string }>;
  steps: Array<{ label: string; status: string; detail?: string }>;
  plan?: {
    queries: string[];
    queryGroups: Array<{ category: string; queries: string[] }>;
    interpretation: Interpretation;
  };
};

type ToolEvent = { tool: string; status: string; message: string; phase?: string; reason?: string };

type ChatItem = {
  id: string;
  sender: "user" | "max";
  text?: string;
  route?: string;
  deepResearch?: boolean;
  session?: Session;
  toolEvents?: ToolEvent[];
  interpretation?: Interpretation;
  error?: string;
  busy?: boolean;
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const EXAMPLE_PROMPTS = [
  { label: "Direct", text: "What is a closure in JavaScript?" },
  { label: "Lookup", text: "What's the latest React version?" },
  { label: "Tanglish", text: "React Native vs Flutter edhu nalla irukku bro?" },
  { label: "Tamil", text: "React இன் latest version என்ன?" },
  { label: "Compare", text: "Compare Supabase and Firebase for a modern startup" },
];

export default function Home() {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [deepResearch, setDeepResearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize service worker and theme
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    const saved = localStorage.getItem("max_theme") as "light" | "dark" | null;
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const chosen = saved ?? preferred;
    setTheme(chosen);
    document.documentElement.setAttribute("data-theme", chosen);
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("max_theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  // Scroll to bottom when messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Server-Sent Events subscription for active research session
  useEffect(() => {
    if (!activeSessionId) return;
    const events = new EventSource(`${API}/api/research/${activeSessionId}/events`);
    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { session?: Session };
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
          .then((s) => {
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

  function updateSessionInMessages(updated: Session) {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.session?.id === updated.id
          ? {
              ...msg,
              session: updated,
              text: updated.answer ?? msg.text,
              busy: !["COMPLETED", "FAILED", "CANCELLED", "NEEDS_CLARIFICATION"].includes(
                updated.status,
              ),
            }
          : msg,
      ),
    );
  }

  async function handleSend(customText?: string) {
    const textToSend = (customText ?? input).trim();
    if (!textToSend || busy) return;

    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `max-${Date.now()}`;

    const userMsg: ChatItem = {
      id: userMessageId,
      sender: "user",
      text: textToSend,
      deepResearch,
    };

    const assistantMsg: ChatItem = {
      id: assistantMessageId,
      sender: "max",
      busy: true,
      deepResearch,
      toolEvents: [],
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: textToSend, deepResearch }),
      });

      if (!response.ok) throw new Error(`MAX API returned HTTP ${response.status}`);

      const payload = (await response.json()) as {
        route: string;
        answer?: string;
        toolEvents: ToolEvent[];
        session?: Session;
        researchId?: string;
        interpretation?: Interpretation;
      };

      if (payload.route === "direct" || payload.answer) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  route: payload.route,
                  text: payload.answer ?? "",
                  session: payload.session,
                  toolEvents: payload.toolEvents,
                  interpretation: payload.interpretation,
                  busy: false,
                }
              : msg,
          ),
        );
        setBusy(false);
      } else {
        const sessionId = payload.researchId ?? payload.session?.id;
        if (sessionId) {
          setActiveSessionId(sessionId);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? {
                    ...msg,
                    route: payload.route,
                    session: payload.session,
                    toolEvents: payload.toolEvents,
                    interpretation: payload.interpretation,
                    busy: true,
                  }
                : msg,
            ),
          );
        }
      }
    } catch (err) {
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
      setBusy(false);
    }
  }

  async function handleCancel(sessionId?: string) {
    const idToCancel = sessionId ?? activeSessionId;
    if (!idToCancel) return;
    try {
      await fetch(`${API}/api/research/${idToCancel}/cancel`, { method: "POST" });
    } catch {
      // Ignored
    } finally {
      setActiveSessionId(null);
      setBusy(false);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.session?.id === idToCancel
            ? {
                ...msg,
                busy: false,
                text: (msg.text ? msg.text + "\n\n" : "") + "[Research stopped by user]",
              }
            : msg,
        ),
      );
    }
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

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="app-container">
      {/* Top Navbar */}
      <header className="navbar">
        <div className="nav-brand">
          <span className="brand-gem">✦</span>
          <strong>MAX</strong>
          <span className="brand-subtitle">Autonomous Research</span>
        </div>
        <div className="nav-controls">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title={`Switch to ${theme === "light" ? "Dark" : "Light"} mode`}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>

      {/* Main Conversation Stream */}
      <main className="chat-stream">
        {messages.length === 0 ? (
          <div className="welcome-hero">
            <div className="hero-pill">PROVEN AUTONOMOUS RESEARCH</div>
            <h1>
              Ask anything. <br />
              <span className="gradient-text">MAX investigates & synthesizes.</span>
            </h1>
            <p className="hero-desc">
              Direct technical explanations, fresh live web search, and evidence-verified deep
              research. Supports English, Tamil, Tanglish, and Hindi natively.
            </p>

            <div className="quick-prompts">
              <span className="quick-label">Try asking:</span>
              <div className="prompt-chips">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex.text}
                    type="button"
                    className="prompt-chip"
                    onClick={() => {
                      setInput(ex.text);
                      textareaRef.current?.focus();
                    }}
                  >
                    <span className="chip-badge">{ex.label}</span>
                    <span className="chip-text">{ex.text}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((item) =>
              item.sender === "user" ? (
                <div key={item.id} className="message-bubble user-bubble">
                  <div className="bubble-content">
                    <p>{item.text}</p>
                    {item.deepResearch && <span className="deep-badge">✦ Deep Research</span>}
                  </div>
                </div>
              ) : (
                <AssistantCard
                  key={item.id}
                  item={item}
                  onCancel={() => handleCancel(item.session?.id)}
                  onClarify={(ans) => item.session && handleClarify(item.session.id, ans)}
                />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      {/* Floating Bottom Input Dock */}
      <footer className="input-dock">
        <form
          className="dock-box"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask MAX anything (English, Tanglish, தமிழ், हिन्दी)..."
            rows={1}
            disabled={busy}
          />
          <div className="dock-actions">
            <button
              type="button"
              className={`deep-toggle ${deepResearch ? "active" : ""}`}
              onClick={() => setDeepResearch(!deepResearch)}
              title="Toggle deep research multi-source thorough mode"
            >
              <span className="deep-spark">✦</span> Deep Research
            </button>

            {busy ? (
              <button
                type="button"
                className="btn-stop"
                onClick={() => void handleCancel()}
                title="Cancel current execution"
              >
                ⏹ Stop
              </button>
            ) : (
              <button
                type="submit"
                className="btn-send"
                disabled={!input.trim()}
                title="Send query (Enter)"
              >
                ↑
              </button>
            )}
          </div>
        </form>
      </footer>
    </div>
  );
}

// Assistant Response Component
function AssistantCard({
  item,
  onCancel,
  onClarify,
}: {
  item: ChatItem;
  onCancel: () => void;
  onClarify: (ans: string) => void;
}) {
  const session = item.session;
  const isResearch = Boolean(session);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [claimsOpen, setClaimsOpen] = useState(false);
  const [highlightedSourceId, setHighlightedSourceId] = useState<string | null>(null);
  const [clarificationInput, setClarificationInput] = useState("");

  const statusPills = getProgressPills(item);

  function handleCitationClick(index: number) {
    const source = session?.sources[index - 1];
    if (source) {
      setSourcesOpen(true);
      setHighlightedSourceId(source.id);
      setTimeout(() => {
        const el = document.getElementById(`source-${source.id}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
      setTimeout(() => setHighlightedSourceId(null), 3000);
    }
  }

  return (
    <div className="message-bubble assistant-card">
      {/* Top Header: Language Tag + Route */}
      <div className="card-top">
        <div className="route-indicator">
          <span className="max-avatar">✦</span>
          <span className="route-name">{item.deepResearch ? "MAX · Deep Research" : "MAX"}</span>
          {item.interpretation?.language && (
            <span className="lang-tag" title={item.interpretation.language.respondIn}>
              🌐 {item.interpretation.language.name}
            </span>
          )}
        </div>

        {item.busy && (
          <div className="busy-badge">
            <span className="pulse-dot" /> Working...
          </div>
        )}
      </div>

      {/* Progressive Tool Activity Pills */}
      {statusPills.length > 0 && (
        <div className="pills-strip">
          {statusPills.map((pill, idx) => (
            <span key={idx} className={`activity-pill ${pill.status}`}>
              <span className="pill-icon">{pill.icon}</span>
              {pill.label}
            </span>
          ))}
        </div>
      )}

      {/* Error state */}
      {item.error && <div className="error-banner">⚠️ {item.error}</div>}

      {/* Main Answer Area */}
      {item.text ? (
        <div className="card-answer">
          <FormattedText text={item.text} onCitationClick={handleCitationClick} />
        </div>
      ) : item.busy && !session?.status ? (
        <div className="thinking-placeholder">
          <span className="shimmer-text">MAX is analyzing request and planning action...</span>
        </div>
      ) : null}

      {/* Clarification Request View */}
      {session?.status === "NEEDS_CLARIFICATION" && (
        <div className="clarification-panel">
          <div className="clarify-title">❓ Clarification needed</div>
          <p className="clarify-question">
            {session.plan?.interpretation.clarificationQuestion ??
              "Could you clarify the exact focus or requirements?"}
          </p>
          <div className="clarify-row">
            <input
              type="text"
              value={clarificationInput}
              onChange={(e) => setClarificationInput(e.target.value)}
              placeholder="Type clarification here..."
              onKeyDown={(e) => {
                if (e.key === "Enter") onClarify(clarificationInput);
              }}
            />
            <button
              type="button"
              className="btn-clarify-send"
              onClick={() => onClarify(clarificationInput)}
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Collapsible Verified Sources Bar */}
      {isResearch && session && session.sources.length > 0 && (
        <div className="drawer-section">
          <button
            type="button"
            className="drawer-toggle"
            onClick={() => setSourcesOpen(!sourcesOpen)}
          >
            <span>
              📄 Cited Sources <strong>({session.sources.length})</strong>
            </span>
            <span className="toggle-chevron">{sourcesOpen ? "▲" : "▼"}</span>
          </button>

          {sourcesOpen && (
            <div className="sources-grid">
              {session.sources.map((src, index) => (
                <a
                  key={src.id}
                  id={`source-${src.id}`}
                  href={src.url}
                  target="_blank"
                  rel="noreferrer"
                  className={`source-item ${highlightedSourceId === src.id ? "highlighted" : ""}`}
                >
                  <div className="source-num">[{index + 1}]</div>
                  <div className="source-details">
                    <div className="source-title">{src.title}</div>
                    <div className="source-meta">
                      <span className="source-domain">{src.domain}</span>
                      <span className="source-quality">
                        {Math.round(src.quality.overall * 100)}% quality
                      </span>
                    </div>
                  </div>
                  <span className="source-arrow">↗</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Verified Claims */}
      {isResearch && session && session.claims.length > 0 && (
        <div className="drawer-section">
          <button
            type="button"
            className="drawer-toggle"
            onClick={() => setClaimsOpen(!claimsOpen)}
          >
            <span>
              ⚖️ Verified Evidence <strong>({session.claims.length})</strong>
            </span>
            <span className="toggle-chevron">{claimsOpen ? "▲" : "▼"}</span>
          </button>

          {claimsOpen && (
            <div className="claims-list">
              {session.claims.map((claim, idx) => (
                <div key={claim.id ?? idx} className="claim-card">
                  <div className="claim-header">
                    <span className={`verdict-badge ${claim.verification?.verdict ?? "supported"}`}>
                      ✓ {claim.verification?.verdict ?? "supported"}
                    </span>
                    <span className="claim-confidence">
                      {Math.round(claim.confidence * 100)}% confidence
                    </span>
                  </div>
                  <div className="claim-text">{claim.text}</div>
                  {claim.verification?.rationale && (
                    <div className="claim-rationale">💡 {claim.verification.rationale}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Inline Citation & Markdown Formatter
function FormattedText({
  text,
  onCitationClick,
}: {
  text: string;
  onCitationClick: (num: number) => void;
}) {
  // Parse paragraphs, code blocks, and citations
  const parts = text.split("\n\n");

  return (
    <div className="formatted-prose">
      {parts.map((part, pIdx) => {
        // Render Markdown Table
        if (part.includes("|") && part.includes("---")) {
          return <TableRenderer key={pIdx} tableText={part} />;
        }

        // Render Code Block
        if (part.startsWith("```")) {
          const lines = part.split("\n");
          const lang = lines[0].replace(/^```/, "").trim() || "code";
          const codeContent = lines.slice(1, -1).join("\n");
          return (
            <div key={pIdx} className="code-container">
              <div className="code-header">{lang}</div>
              <pre className="code-block">
                <code>{codeContent}</code>
              </pre>
            </div>
          );
        }

        // Render Paragraph with [1] clickable citation tags
        return (
          <p key={pIdx}>
            <CitationLine line={part} onCitationClick={onCitationClick} />
          </p>
        );
      })}
    </div>
  );
}

function CitationLine({
  line,
  onCitationClick,
}: {
  line: string;
  onCitationClick: (num: number) => void;
}) {
  // Matches [1], [2], etc.
  const regex = /\[(\d+)\]/g;
  const elements: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      elements.push(line.slice(lastIndex, match.index));
    }
    const citationNum = Number(match[1]);
    elements.push(
      <button
        key={`${match.index}-${citationNum}`}
        type="button"
        className="citation-pill"
        onClick={() => onCitationClick(citationNum)}
        title={`Jump to source [${citationNum}]`}
      >
        [{citationNum}]
      </button>,
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    elements.push(line.slice(lastIndex));
  }

  return <>{elements}</>;
}

function TableRenderer({ tableText }: { tableText: string }) {
  const lines = tableText.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return <pre>{tableText}</pre>;

  const headers = lines[0]
    .split("|")
    .map((h) => h.trim())
    .filter(Boolean);
  const rows = lines.slice(2).map((row) =>
    row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean),
  );

  return (
    <div className="table-responsive">
      <table className="custom-table">
        <thead>
          <tr>
            {headers.map((h, idx) => (
              <th key={idx}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function getProgressPills(item: ChatItem): Array<{ icon: string; label: string; status: string }> {
  const pills: Array<{ icon: string; label: string; status: string }> = [];

  // Understanding step
  pills.push({
    icon: "🤔",
    label: "Understanding",
    status: "complete",
  });

  const session = item.session;
  if (!session) {
    if (item.text) {
      pills.push({
        icon: "✍️",
        label: "Answer",
        status: "complete",
      });
    }
    return pills;
  }

  const hasSearch = session.steps.some(
    (s) => s.label.includes("web_search") || s.label.includes("search_again"),
  );
  const hasFetch = session.steps.some((s) => s.label.includes("fetch_url"));
  const hasVerify = session.steps.some(
    (s) => s.label.includes("verify_claims") || s.label.includes("verify_claim"),
  );
  const hasSynth = session.steps.some((s) => s.label.includes("synthesize"));

  if (hasSearch || session.status === "SEARCHING") {
    pills.push({
      icon: "🔎",
      label:
        session.sources.length > 0
          ? `Searching the web (${session.sources.length} sources)`
          : "Searching the web",
      status: session.sources.length > 0 ? "complete" : "running",
    });
  }

  if (hasFetch || session.status === "FETCHING") {
    pills.push({
      icon: "📄",
      label: "Reading sources",
      status:
        session.sources.some((s) => s.content) || session.status === "COMPLETED"
          ? "complete"
          : "running",
    });
  }

  // Only display verification if verification actually executed
  if (hasVerify) {
    pills.push({
      icon: "🧠",
      label: `Verifying evidence (${session.claims.length} claims)`,
      status: session.claims.some((c) => c.verification) ? "complete" : "running",
    });
  }

  if (hasSynth || session.answer || session.status === "COMPLETED") {
    pills.push({
      icon: "✍️",
      label: "Answer",
      status: session.answer ? "complete" : "running",
    });
  }

  return pills;
}

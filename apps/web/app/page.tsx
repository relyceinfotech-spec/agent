"use client";
import { FormEvent, useEffect, useState } from "react";

type Source = {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  content?: string;
  fetchError?: string;
  quality: { overall: number };
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
};
type Session = {
  id: string;
  question: string;
  mode: "quick" | "deep";
  status: string;
  answer?: string;
  error?: string;
  sources: Source[];
  claims: Array<{
    id: string;
    text: string;
    evidence: string;
    confidence: number;
    verification?: { verdict: string };
  }>;
  conflicts?: Array<{ id: string; description: string; status: string }>;
  steps: Array<{ label: string; status: string; detail?: string }>;
  plan?: {
    queries: string[];
    queryGroups: Array<{ category: string; queries: string[] }>;
    interpretation: Interpretation;
  };
};
type ToolEvent = { tool: string; status: string; message: string };
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function Home() {
  const [question, setQuestion] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [answer, setAnswer] = useState("");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
  }, []);
  useEffect(() => {
    if (!session || ["COMPLETED", "FAILED", "NEEDS_CLARIFICATION"].includes(session.status)) return;
    const events = new EventSource(`${API}/api/research/${session.id}/events`);
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { session?: Session };
      if (payload.session) setSession(payload.session);
      else
        fetch(`${API}/api/research/${session.id}`)
          .then((response) => response.json())
          .then(setSession);
    };
    return () => events.close();
  }, [session?.id, session?.status]);
  async function send(deepResearch: boolean) {
    if (!question.trim()) return;
    setError("");
    setBusy(true);
    setAnswer("");
    setSession(null);
    setToolEvents([]);
    try {
      const response = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, deepResearch }),
      });
      if (!response.ok) throw new Error("Could not start MAX");
      const payload = (await response.json()) as {
        route: string;
        answer?: string;
        toolEvents: ToolEvent[];
        session?: Session;
        researchId?: string;
      };
      setToolEvents(payload.toolEvents ?? []);
      if (payload.route === "direct") setAnswer(payload.answer ?? "");
      else if (payload.session) setSession(payload.session);
      else if (payload.researchId)
        setSession(
          await fetch(`${API}/api/research/${payload.researchId}`).then((result) => result.json()),
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }
  return (
    <main>
      <nav>
        <div className="brand">
          <span className="mark">✦</span> Research Agent <strong>MAX</strong>
        </div>
        <span className="nav-note">Autonomous research workspace</span>
      </nav>
      <section className="hero">
        <div className="eyebrow">AUTONOMOUS AGENT</div>
        <h1>
          Ask anything.
          <br />
          <em>MAX decides.</em>
        </h1>
        <p className="lede">
          One intelligent workspace for direct answers, fresh web lookups, and deep evidence-backed
          research.
        </p>
        <form onSubmit={submit} className="research-box">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask Research Agent MAX anything…"
            minLength={2}
            required
          />
          <div className="form-row">
            <span className="auto-note">✦ Autonomous by default</span>
            <div className="send-actions">
              <button
                type="button"
                className="deep-button"
                disabled={busy}
                onClick={() => void send(true)}
              >
                Deep Research
              </button>
              <button type="submit" className="start" disabled={busy}>
                {busy ? "Working…" : "Send  ↑"}
              </button>
            </div>
          </div>
        </form>
        <div className="examples">
          <span>Try:</span>
          {[
            "What is a closure in JavaScript?",
            "What's the latest React Native version?",
            "Compare Supabase and Firebase for my startup",
          ].map((example) => (
            <button key={example} onClick={() => setQuestion(example)}>
              {example}
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      {toolEvents.length > 0 && !session && <ToolActivity events={toolEvents} />}
      {answer && <DirectAnswer answer={answer} events={toolEvents} />}
      {session && <ResearchView session={session} onUpdate={setSession} />}
    </main>
  );
}

function ToolActivity({ events }: { events: ToolEvent[] }) {
  return (
    <section className="tool-activity">
      <div className="report-label">AGENT ACTIVITY</div>
      {events.map((event, index) => (
        <span key={`${event.tool}-${index}`} className={event.status}>
          <b>{event.status === "complete" ? "✓" : event.status === "failed" ? "!" : "·"}</b>{" "}
          {event.tool}
        </span>
      ))}
    </section>
  );
}
function DirectAnswer({ answer, events }: { answer: string; events: ToolEvent[] }) {
  return (
    <section className="direct-answer">
      <div className="report-label">MAX ANSWERED DIRECTLY</div>
      {events.length > 0 && <ToolActivity events={events} />}
      <div className="answer">
        {answer.split("\n").map((line, index) => (
          <p key={index}>{line || " "}</p>
        ))}
      </div>
    </section>
  );
}

function ResearchView({
  session,
  onUpdate,
}: {
  session: Session;
  onUpdate: (session: Session) => void;
}) {
  const done = session.status === "COMPLETED";
  const awaiting = session.status === "NEEDS_CLARIFICATION";
  const [clarification, setClarification] = useState("");
  const [clarifyBusy, setClarifyBusy] = useState(false);
  async function clarify(event: FormEvent) {
    event.preventDefault();
    setClarifyBusy(true);
    try {
      const response = await fetch(`${API}/api/research/${session.id}/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: clarification }),
      });
      if (!response.ok) throw new Error("Could not continue research");
      onUpdate(await fetch(`${API}/api/research/${session.id}`).then((result) => result.json()));
    } finally {
      setClarifyBusy(false);
    }
  }
  const interpretation = session.plan?.interpretation;
  return (
    <section className="workspace">
      <div className="workspace-head">
        <div>
          <div className="eyebrow">
            {session.mode === "deep" ? "DEEP RESEARCH" : "AUTONOMOUS RESEARCH"}
          </div>
          <h2>{session.question.split("\n")[0]}</h2>
        </div>
        <span
          className={`status ${done ? "done" : session.status === "FAILED" ? "failed" : awaiting ? "clarify" : "working"}`}
        >
          {awaiting ? "clarification needed" : session.status.toLowerCase()}
        </span>
      </div>
      <div className="grid">
        <aside className="process">
          <h3>Tool activity</h3>
          {session.steps.map((step, index) => (
            <div className="step" key={`${step.label}-${index}`}>
              <span className={step.status === "complete" ? "check complete" : "check"}>
                {step.status === "complete" ? "✓" : "·"}
              </span>
              <div>
                <strong>{step.label}</strong>
                {step.detail && <small>{step.detail}</small>}
              </div>
            </div>
          ))}
          {!done && !awaiting && session.status !== "FAILED" && (
            <div className="pulse">MAX is deciding what to do next…</div>
          )}
          {awaiting && (
            <form className="clarify-box" onSubmit={clarify}>
              <strong>
                {interpretation?.clarificationQuestion ??
                  "Can you clarify what you want MAX to investigate?"}
              </strong>
              <textarea
                value={clarification}
                onChange={(event) => setClarification(event.target.value)}
                placeholder="Add the focus or decision criteria…"
                required
              />
              <button className="start" disabled={clarifyBusy}>
                {clarifyBusy ? "Continuing…" : "Continue research  →"}
              </button>
            </form>
          )}
        </aside>
        <article className="report">
          {interpretation && (
            <div className="interpretation">
              <div className="report-label">QUERY UNDERSTANDING</div>
              <div className="interpretation-row">
                <span>
                  <b>Intent</b>
                  {interpretation.intent}
                </span>
                <span>
                  <b>Topic</b>
                  {interpretation.topic}
                </span>
                <span>
                  <b>Ambiguity</b>
                  {interpretation.ambiguityScore.toFixed(2)}
                </span>
              </div>
              {interpretation.entities.length > 0 && (
                <div className="chips">
                  {interpretation.entities.map((entity) => (
                    <span key={entity}>{entity}</span>
                  ))}
                </div>
              )}
              {interpretation.corrections.length > 0 && (
                <small>
                  Safe terminology corrections:{" "}
                  {interpretation.corrections.map((item) => `${item.from} → ${item.to}`).join(", ")}
                </small>
              )}
            </div>
          )}
          <div className="report-label">FINAL REPORT</div>
          {session.answer ? (
            <div className="answer">
              {session.answer.split("\n").map((line, index) => (
                <p key={index}>{line || " "}</p>
              ))}
            </div>
          ) : (
            <div className="empty-report">
              {awaiting
                ? "MAX paused before search because the request needs clarification."
                : "Your cited report will appear here as MAX completes the investigation."}
            </div>
          )}
          <h3>
            Evidence <span>{session.claims.length}</span>
          </h3>
          {session.claims.slice(0, 8).map((claim) => (
            <div className="claim" key={claim.id}>
              <div className="claim-top">
                <span>Claim</span>
                <span>
                  {claim.verification?.verdict ??
                    `${Math.round(claim.confidence * 100)}% confidence`}
                </span>
              </div>
              <p>{claim.text}</p>
            </div>
          ))}
          {(session.conflicts?.length ?? 0) > 0 && (
            <>
              <h3>
                Conflicts <span>{session.conflicts?.length}</span>
              </h3>
              {session.conflicts?.map((conflict) => (
                <div className="conflict" key={conflict.id}>
                  <div className="claim-top">
                    <span>{conflict.status}</span>
                    <span>Needs review</span>
                  </div>
                  <p>{conflict.description}</p>
                </div>
              ))}
            </>
          )}
          <h3>
            Sources <span>{session.sources.length}</span>
          </h3>
          <div className="sources">
            {session.sources.map((source) => (
              <a
                className="source"
                href={source.url}
                target="_blank"
                rel="noreferrer"
                key={source.id}
              >
                <div>
                  <strong>{source.title}</strong>
                  <small>
                    {source.domain} · quality {Math.round(source.quality.overall * 100)}%
                  </small>
                </div>
                <span>↗</span>
              </a>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

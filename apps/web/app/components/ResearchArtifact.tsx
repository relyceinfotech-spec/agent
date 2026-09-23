"use client";

import React, { useState } from "react";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { AgentActivity, deriveActivitySteps } from "./AgentActivity";
import { SourcesDrawer, SourceItem } from "./SourcesDrawer";
import { EvidenceSection, ClaimItem } from "./EvidenceSection";

export type InterpretationData = {
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
  language?: { detected: string; name: string; respondIn: string };
  formatPreference?: string;
};

export type SessionData = {
  id: string;
  question: string;
  mode: "quick" | "deep";
  status: string;
  answer?: string;
  error?: string;
  sources: SourceItem[];
  claims: ClaimItem[];
  conflicts?: Array<{ id: string; description: string; status: string }>;
  steps: Array<{ label: string; status: string; detail?: string }>;
  plan?: {
    queries: string[];
    queryGroups: Array<{ category: string; queries: string[] }>;
    interpretation: InterpretationData;
  };
};

export type ResearchMessageItem = {
  id: string;
  sender: "user" | "max";
  text?: string;
  userPrompt?: string;
  route?: string;
  deepResearch?: boolean;
  session?: SessionData;
  interpretation?: InterpretationData;
  error?: string;
  busy?: boolean;
};

interface ResearchArtifactProps {
  item: ResearchMessageItem;
  onCancel: () => void;
  onClarify: (answer: string) => void;
  onRetry: () => void;
}

export function ResearchArtifact({ item, onCancel, onClarify, onRetry }: ResearchArtifactProps) {
  const session = item.session;
  const isResearch = Boolean(session);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [highlightedSourceId, setHighlightedSourceId] = useState<string | null>(null);
  const [clarificationInput, setClarificationInput] = useState("");
  const [copiedAnswer, setCopiedAnswer] = useState(false);

  // Derive runtime-truthful progress steps
  const activitySteps = deriveActivitySteps(session, Boolean(item.text), item.busy);

  // Jump smoothly to cited source when clicking [1], [2]
  function handleCitationClick(index: number) {
    const source = session?.sources[index - 1];
    if (source) {
      setSourcesOpen(true);
      setHighlightedSourceId(source.id);
      setTimeout(() => {
        const element = document.getElementById(`source-${source.id}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 120);
      setTimeout(() => setHighlightedSourceId(null), 2500);
    }
  }

  async function handleCopyAnswer() {
    if (!item.text) return;
    try {
      await navigator.clipboard.writeText(item.text);
      setCopiedAnswer(true);
      setTimeout(() => setCopiedAnswer(false), 2000);
    } catch {
      setCopiedAnswer(false);
    }
  }

  // Derive route badge
  const routeLabel = item.deepResearch
    ? "DEEP RESEARCH REPORT"
    : session?.sources && session.sources.length > 0
      ? "LIVE WEB SYNTHESIS"
      : "DIRECT SYNTHESIS";

  return (
    <article className="research-artifact-card" aria-label="Research synthesis artifact">
      {/* Top Header Bar */}
      <div className="artifact-header">
        <div className="artifact-identity">
          <span className="artifact-gem" aria-hidden="true">
            ✦
          </span>
          <div className="artifact-titles">
            <span className="artifact-agent-name">MAX</span>
            <span className="artifact-route-pill">{routeLabel}</span>
          </div>

          {item.interpretation?.language && (
            <span className="artifact-lang-tag" title={item.interpretation.language.respondIn}>
              🌐 {item.interpretation.language.name}
            </span>
          )}
        </div>

        <div className="artifact-header-actions">
          {item.busy && (
            <div className="status-busy-indicator">
              <span className="busy-pulse" />
              <span>Investigating...</span>
            </div>
          )}

          {item.text && !item.busy && (
            <button
              type="button"
              className="btn-artifact-copy"
              onClick={handleCopyAnswer}
              title="Copy complete synthesis as Markdown"
            >
              <span className="copy-icon">{copiedAnswer ? "✓" : "📋"}</span>
              <span>{copiedAnswer ? "Copied" : "Copy Brief"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Runtime Agent Activity Timeline */}
      {activitySteps.length > 0 && <AgentActivity steps={activitySteps} isBusy={item.busy} />}

      {/* Error state with Retry action */}
      {item.error && (
        <div className="artifact-error-banner" role="alert">
          <div className="error-content">
            <span className="error-icon" aria-hidden="true">
              ⚠️
            </span>
            <div className="error-message">
              <strong>Investigation interrupted</strong>
              <p>{item.error}</p>
            </div>
          </div>
          <button
            type="button"
            className="btn-error-retry"
            onClick={onRetry}
            title="Retry this investigation"
          >
            🔄 Retry
          </button>
        </div>
      )}

      {/* Main Research Content Body */}
      {item.text ? (
        <div className="artifact-body">
          <MarkdownRenderer content={item.text} onCitationClick={handleCitationClick} />
        </div>
      ) : item.busy && !session?.status ? (
        <div className="artifact-shimmer-placeholder">
          <div className="shimmer-line line-wide" />
          <div className="shimmer-line line-mid" />
          <div className="shimmer-line line-short" />
          <span className="shimmer-status-text">
            MAX is evaluating routing and planning inquiry...
          </span>
        </div>
      ) : null}

      {/* Clarification Request Modal / Panel */}
      {session?.status === "NEEDS_CLARIFICATION" && (
        <div className="clarification-card">
          <div className="clarify-head">
            <span className="clarify-icon">❓</span>
            <span className="clarify-tag">CLARIFICATION REQUEST</span>
          </div>
          <p className="clarify-prompt">
            {session.plan?.interpretation.clarificationQuestion ||
              "Could you clarify the exact focus or requirements?"}
          </p>
          <div className="clarify-action-row">
            <input
              type="text"
              className="clarify-text-input"
              value={clarificationInput}
              onChange={(e) => setClarificationInput(e.target.value)}
              placeholder="Type your clarification..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && clarificationInput.trim()) {
                  onClarify(clarificationInput);
                }
              }}
            />
            <button
              type="button"
              className="btn-clarify-proceed"
              onClick={() => clarificationInput.trim() && onClarify(clarificationInput)}
              disabled={!clarificationInput.trim()}
            >
              Continue Investigation →
            </button>
          </div>
        </div>
      )}

      {/* Cited Sources Panel */}
      {isResearch && session && session.sources && session.sources.length > 0 && (
        <SourcesDrawer
          sources={session.sources}
          isOpen={sourcesOpen}
          onToggle={() => setSourcesOpen(!sourcesOpen)}
          highlightedSourceId={highlightedSourceId}
        />
      )}

      {/* Verified Evidence Panel */}
      {isResearch && session && session.claims && session.claims.length > 0 && (
        <EvidenceSection
          claims={session.claims}
          isOpen={evidenceOpen}
          onToggle={() => setEvidenceOpen(!evidenceOpen)}
        />
      )}
    </article>
  );
}

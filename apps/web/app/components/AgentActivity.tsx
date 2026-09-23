"use client";

import React from "react";

export type ActivityStep = {
  id: string;
  icon: string;
  label: string;
  status: "complete" | "running" | "pending";
};

interface AgentActivityProps {
  steps: ActivityStep[];
  isBusy?: boolean;
}

export function AgentActivity({ steps, isBusy }: AgentActivityProps) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="agent-activity-bar" aria-label="Agent investigation activity">
      <div className="activity-label-wrap">
        <span className="activity-pulse-spark" aria-hidden="true">
          ✦
        </span>
        <span className="activity-heading">INVESTIGATION TIMELINE</span>
      </div>

      <div className="activity-steps-flow">
        {steps.map((step, idx) => (
          <div key={step.id || idx} className={`activity-step-node ${step.status}`}>
            <div className="step-badge">
              <span className="step-icon">{step.icon}</span>
              <span className="step-label">{step.label}</span>
              {step.status === "running" && (
                <span className="step-spinner" aria-label="In progress" />
              )}
            </div>
            {idx < steps.length - 1 && <span className="step-connector" aria-hidden="true" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Derives user-friendly runtime-truthful progress steps from session data and tool events
 */
export function deriveActivitySteps(
  session?: {
    status: string;
    sources?: Array<{ id: string; content?: string }>;
    claims?: Array<{ id: string; verification?: unknown }>;
    steps?: Array<{ label: string; status: string; detail?: string }>;
    answer?: string;
  },
  hasDirectAnswer?: boolean,
  isBusy?: boolean,
): ActivityStep[] {
  const steps: ActivityStep[] = [];

  // 1. Understanding phase (always happens first)
  steps.push({
    id: "understand",
    icon: "🤔",
    label: "Understanding query",
    status: "complete",
  });

  if (!session) {
    if (hasDirectAnswer) {
      steps.push({
        id: "answer",
        icon: "✍️",
        label: "Direct synthesis",
        status: "complete",
      });
    } else if (isBusy) {
      steps.push({
        id: "planning",
        icon: "⚡",
        label: "Evaluating routing",
        status: "running",
      });
    }
    return steps;
  }

  const sessionSteps = session.steps || [];
  const hasSearch = sessionSteps.some(
    (s) => s.label.includes("web_search") || s.label.includes("search_again"),
  );
  const hasFetch = sessionSteps.some((s) => s.label.includes("fetch_url"));
  const hasVerify = sessionSteps.some(
    (s) => s.label.includes("verify_claims") || s.label.includes("verify_claim"),
  );
  const hasConflict = sessionSteps.some((s) => s.label.includes("detect_conflict"));
  const hasSynthesis = sessionSteps.some((s) => s.label.includes("synthesize"));
  const isCompleted = ["COMPLETED"].includes(session.status);

  // 2. Search phase
  if (hasSearch || session.status === "SEARCHING") {
    const sourceCount = session.sources?.length || 0;
    const isDone = sourceCount > 0 || hasFetch || isCompleted;
    steps.push({
      id: "search",
      icon: "🔎",
      label: sourceCount > 0 ? `Searched web (${sourceCount} sources)` : "Searching live web",
      status: isDone ? "complete" : "running",
    });
  }

  // 3. Reading / extraction phase
  if (hasFetch || session.status === "FETCHING") {
    const fetchedCount = session.sources?.filter((s) => Boolean(s.content)).length || 0;
    const isDone = hasVerify || hasSynthesis || isCompleted;
    steps.push({
      id: "read",
      icon: "📄",
      label: fetchedCount > 0 ? `Read ${fetchedCount} sources` : "Reading retrieved pages",
      status: isDone ? "complete" : "running",
    });
  }

  // 4. Verification / Conflict phase
  if (hasVerify || hasConflict || session.status === "VERIFYING") {
    const claimCount = session.claims?.length || 0;
    const verifiedCount = session.claims?.filter((c) => Boolean(c.verification)).length || 0;
    const isDone = verifiedCount > 0 || hasSynthesis || isCompleted;
    steps.push({
      id: "verify",
      icon: "⚖️",
      label:
        claimCount > 0
          ? `Verified ${verifiedCount}/${claimCount} claims`
          : "Cross-checking evidence",
      status: isDone ? "complete" : "running",
    });
  }

  // 5. Synthesis phase
  if (hasSynthesis || session.answer || isCompleted) {
    steps.push({
      id: "synthesize",
      icon: "✍️",
      label: "Synthesizing research answer",
      status: session.answer ? "complete" : "running",
    });
  }

  return steps;
}

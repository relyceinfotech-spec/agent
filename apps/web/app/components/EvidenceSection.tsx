"use client";

import React from "react";

export type ClaimItem = {
  id: string;
  text: string;
  evidence: string;
  confidence: number;
  importance?: "critical" | "high" | "medium" | "low";
  objectiveId?: string;
  verification?: {
    verdict: "supported" | "contradicted" | "uncertain" | "unavailable";
    rationale?: string;
  };
};

interface EvidenceSectionProps {
  claims: ClaimItem[];
  isOpen: boolean;
  onToggle: () => void;
}

export function EvidenceSection({ claims, isOpen, onToggle }: EvidenceSectionProps) {
  if (!claims || claims.length === 0) return null;

  return (
    <div className="evidence-section">
      <button type="button" className="evidence-toggle" onClick={onToggle} aria-expanded={isOpen}>
        <div className="toggle-left">
          <span className="drawer-icon" aria-hidden="true">
            ⚖️
          </span>
          <span className="drawer-heading">
            Verified Evidence Claims <span className="claims-count">({claims.length})</span>
          </span>
        </div>
        <div className="toggle-right">
          <span className="toggle-hint">{isOpen ? "Hide Evidence" : "Inspect Evidence"}</span>
          <span className="toggle-chevron" aria-hidden="true">
            {isOpen ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {isOpen && (
        <div className="claims-list-wrapper">
          <div className="claims-list">
            {claims.map((claim, idx) => {
              const verdict = claim.verification?.verdict || "supported";
              const confidencePct = Math.round(claim.confidence * 100);

              return (
                <div key={claim.id || idx} className="claim-card-interactive">
                  <div className="claim-top-row">
                    <div className="claim-badges-group">
                      <span className={`verdict-tag ${verdict}`}>
                        {verdict === "supported" && "✓ "}
                        {verdict === "contradicted" && "✗ "}
                        {verdict === "uncertain" && "? "}
                        {verdict.toUpperCase()}
                      </span>
                      {claim.importance && (
                        <span className={`claim-importance-tag importance-${claim.importance}`}>
                          {claim.importance.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className="confidence-metric">{confidencePct}% confidence</span>
                  </div>

                  <div className="claim-body-text">{claim.text}</div>

                  {claim.verification?.rationale && (
                    <div className="claim-rationale-box">
                      <span className="rationale-label">Cross-check finding:</span>
                      <span className="rationale-text">{claim.verification.rationale}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

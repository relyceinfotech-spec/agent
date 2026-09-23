"use client";

import React from "react";

export type ObjectiveItem = {
  id: string;
  label: string;
  category: string;
  importance: "critical" | "high" | "medium" | "low";
  status: "pending" | "investigating" | "fulfilled" | "partial" | "blocked";
  evidenceIds?: string[];
  sourceIds?: string[];
  coverage: number;
  keyFinding?: string;
};

interface ObjectivesSectionProps {
  objectives: ObjectiveItem[];
  coverage?: number;
  isOpen: boolean;
  onToggle: () => void;
}

export function ObjectivesSection({
  objectives,
  coverage,
  isOpen,
  onToggle,
}: ObjectivesSectionProps) {
  if (!objectives || objectives.length === 0) return null;

  const fulfilledCount = objectives.filter(
    (o) => o.status === "fulfilled" || o.coverage >= 0.9,
  ).length;
  const coveragePct =
    coverage !== undefined
      ? Math.round(coverage * 100)
      : Math.round(
          (objectives.reduce((acc, curr) => acc + (curr.coverage || 0), 0) / objectives.length) *
            100,
        );

  return (
    <div className="objectives-section">
      <button type="button" className="objectives-toggle" onClick={onToggle} aria-expanded={isOpen}>
        <div className="toggle-left">
          <span className="drawer-icon" aria-hidden="true">
            🎯
          </span>
          <span className="drawer-heading">
            Research Objectives{" "}
            <span className="objectives-count">
              ({fulfilledCount}/{objectives.length} fulfilled)
            </span>
          </span>
          <span className="coverage-badge-small">{coveragePct}% Coverage</span>
        </div>
        <div className="toggle-right">
          <span className="toggle-hint">{isOpen ? "Hide Objectives" : "Inspect Objectives"}</span>
          <span className="toggle-chevron" aria-hidden="true">
            {isOpen ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {isOpen && (
        <div className="objectives-list-wrapper">
          <div className="objectives-progress-bar-container">
            <div className="objectives-progress-bar-track">
              <div
                className="objectives-progress-bar-fill"
                style={{ width: `${Math.min(100, Math.max(0, coveragePct))}%` }}
              />
            </div>
            <div className="objectives-progress-metrics">
              <span>Weighted Evidence Coverage</span>
              <span className="progress-pct-val">{coveragePct}% Verified</span>
            </div>
          </div>

          <div className="objectives-grid">
            {objectives.map((obj, idx) => {
              const objCoveragePct = Math.round((obj.coverage || 0) * 100);
              const status = obj.status || (obj.coverage >= 0.9 ? "fulfilled" : "pending");

              return (
                <div key={obj.id || idx} className={`objective-card status-${status}`}>
                  <div className="objective-card-header">
                    <div className="objective-badges">
                      <span className={`status-pill pill-${status}`}>
                        {status === "fulfilled" && "✓ Fulfilled"}
                        {status === "partial" && "◐ Partial"}
                        {status === "investigating" && "⟳ In Progress"}
                        {status === "pending" && "○ Pending"}
                        {status === "blocked" && "✕ Blocked"}
                      </span>
                      {obj.importance && (
                        <span className={`importance-tag importance-${obj.importance}`}>
                          {obj.importance.toUpperCase()}
                        </span>
                      )}
                      {obj.category && <span className="category-pill">{obj.category}</span>}
                    </div>
                    <span className="objective-coverage-val">{objCoveragePct}%</span>
                  </div>

                  <h5 className="objective-label">{obj.label}</h5>

                  {obj.keyFinding && (
                    <div className="objective-finding-box">
                      <span className="finding-label">Evidence finding:</span>
                      <p className="finding-text">{obj.keyFinding}</p>
                    </div>
                  )}

                  <div className="objective-meta-row">
                    <span className="objective-meta-item">
                      📊 {obj.evidenceIds?.length || 0} verified claims
                    </span>
                    <span className="objective-meta-item">
                      🔗 {obj.sourceIds?.length || 0} sources consulted
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

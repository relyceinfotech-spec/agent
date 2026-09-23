"use client";

import React from "react";

export type SourceItem = {
  id: string;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  content?: string;
  quality: { overall: number; relevance: number; authority: number; freshness: number };
};

interface SourcesDrawerProps {
  sources: SourceItem[];
  isOpen: boolean;
  onToggle: () => void;
  highlightedSourceId: string | null;
}

export function SourcesDrawer({
  sources,
  isOpen,
  onToggle,
  highlightedSourceId,
}: SourcesDrawerProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="sources-drawer-section">
      <button
        type="button"
        className="sources-drawer-toggle"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <div className="toggle-left">
          <span className="drawer-icon" aria-hidden="true">
            📄
          </span>
          <span className="drawer-heading">
            Cited Web Sources <span className="sources-count">({sources.length})</span>
          </span>
        </div>
        <div className="toggle-right">
          <span className="toggle-hint">{isOpen ? "Hide Sources" : "View Sources"}</span>
          <span className="toggle-chevron" aria-hidden="true">
            {isOpen ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {isOpen && (
        <div className="sources-grid-wrapper">
          <div className="sources-grid">
            {sources.map((src, index) => {
              const cleanDomain = src.domain.replace(/^www\./, "");
              const qualityPct = Math.round(src.quality.overall * 100);
              const isHighlighted = highlightedSourceId === src.id;

              return (
                <a
                  key={src.id}
                  id={`source-${src.id}`}
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`source-card-interactive ${isHighlighted ? "highlighted-glow" : ""}`}
                  title={`Open ${cleanDomain} in a new tab`}
                >
                  <div className="source-card-header">
                    <span className="source-index-badge">[{index + 1}]</span>
                    <span className="source-domain-pill">{cleanDomain}</span>
                    <span className="source-quality-metric">{qualityPct}% quality</span>
                  </div>

                  <h5 className="source-card-title">{src.title}</h5>

                  {src.snippet && <p className="source-card-snippet">{src.snippet}</p>}

                  <div className="source-card-footer">
                    <span className="source-external-link">
                      Visit source <span className="arrow-glyph">↗</span>
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

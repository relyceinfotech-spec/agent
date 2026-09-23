"use client";

import React from "react";

export type ExampleCategory = {
  category: string;
  items: Array<{ label: string; text: string; description: string }>;
};

const RESEARCH_EXAMPLES: ExampleCategory[] = [
  {
    category: "Technical Lookup",
    items: [
      {
        label: "JavaScript",
        text: "What is a closure in JavaScript and how does lexical scoping create memory leaks?",
        description: "Direct architectural synthesis without web overhead",
      },
      {
        label: "React 19",
        text: "What are the core breaking changes and Server Actions features in React 19?",
        description: "Fresh live web verification with cited release notes",
      },
    ],
  },
  {
    category: "Multilingual & Indic",
    items: [
      {
        label: "Tanglish",
        text: "React Native vs Flutter edhu modern mobile apps ku nalla irukku bro? Performance comparison sollu",
        description: "Natural colloquial Tanglish synthesis with technical rigor",
      },
      {
        label: "தமிழ்",
        text: "செயற்கை நுண்ணறிவின் சமீபத்திய முன்னேற்றங்கள் மற்றும் எதிர்கால தாக்கம் என்ன?",
        description: "Native Tamil script investigation and structured summary",
      },
    ],
  },
  {
    category: "Comparative Analysis",
    items: [
      {
        label: "Architecture",
        text: "Compare Supabase vs Firebase for a multi-tenant enterprise SaaS: security, latency, and cost",
        description: "Multi-vector evaluation with structured findings",
      },
      {
        label: "Vector DBs",
        text: "Milvus vs Qdrant vs pgvector: benchmarking memory, retrieval latency, and scale",
        description: "In-depth multi-source deep research report",
      },
    ],
  },
];

interface HeroLandingProps {
  onSelectPrompt: (text: string, deep?: boolean) => void;
}

export function HeroLanding({ onSelectPrompt }: HeroLandingProps) {
  return (
    <div className="hero-landing">
      {/* Top Banner Tag */}
      <div className="hero-badge">
        <span className="badge-spark">✦</span>
        <span>AUTONOMOUS EVIDENCE-BASED AGENT</span>
      </div>

      {/* Main Title & Narrative */}
      <h1 className="hero-headline">
        Research, not just <br />
        <span className="gradient-headline">surface-level answers.</span>
      </h1>

      <p className="hero-subtext">
        MAX autonomously determines whether to answer instantly, query live web sources, or conduct
        deep multi-stage evidence verification. Native support for English, Tamil, Tanglish, and
        Hindi.
      </p>

      {/* Trust & Architecture Pillars */}
      <div className="trust-grid">
        <div className="trust-card">
          <div className="trust-icon">⚡</div>
          <div className="trust-content">
            <strong>Adaptive Depth</strong>
            <p>
              Answers direct questions instantly; invokes live web search only when fresh data is
              required.
            </p>
          </div>
        </div>

        <div className="trust-card">
          <div className="trust-icon">⚖️</div>
          <div className="trust-content">
            <strong>Evidence Cross-Checking</strong>
            <p>
              Extracts verifiable claims, detects conflicting reports, and attaches authoritative
              citations.
            </p>
          </div>
        </div>

        <div className="trust-card">
          <div className="trust-icon">🌐</div>
          <div className="trust-content">
            <strong>Multilingual Intelligence</strong>
            <p>
              Natively comprehends and synthesizes English, Tamil, Tanglish, and Hindi without
              translation lag.
            </p>
          </div>
        </div>
      </div>

      {/* Categorized Inquiry Starters */}
      <div className="inquiry-starters">
        <div className="starters-header">
          <span className="starters-title">Explore Research Scenarios</span>
          <span className="starters-subtitle">Click any inquiry to launch an investigation</span>
        </div>

        <div className="categories-stack">
          {RESEARCH_EXAMPLES.map((cat) => (
            <div key={cat.category} className="category-group">
              <span className="category-label">{cat.category}</span>
              <div className="cards-grid">
                {cat.items.map((item) => (
                  <button
                    key={item.text}
                    type="button"
                    className="starter-card"
                    onClick={() =>
                      onSelectPrompt(
                        item.text,
                        item.label === "Architecture" || item.label === "Vector DBs",
                      )
                    }
                  >
                    <div className="starter-card-top">
                      <span className="starter-badge">{item.label}</span>
                      <span className="starter-arrow">→</span>
                    </div>
                    <div className="starter-query">{item.text}</div>
                    <div className="starter-desc">{item.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

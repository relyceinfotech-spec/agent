"use client";

import React from "react";

export type RecentItem = {
  id: string;
  title: string;
  timestamp: number;
  deepResearch?: boolean;
};

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  recentSearches: RecentItem[];
  onSelectRecent: (item: RecentItem) => void;
  onNewInvestigation: () => void;
  onClearHistory: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Sidebar({
  isOpen,
  onToggle,
  recentSearches,
  onSelectRecent,
  onNewInvestigation,
  onClearHistory,
  theme,
  onToggleTheme,
}: SidebarProps) {
  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && <div className="sidebar-backdrop" onClick={onToggle} aria-hidden="true" />}

      <aside className={`app-sidebar ${isOpen ? "open" : "collapsed"}`}>
        {/* Brand Header */}
        <div className="sidebar-header">
          <div className="brand-group">
            <span className="brand-gem" aria-hidden="true">
              ✦
            </span>
            <div className="brand-text">
              <span className="brand-title">MAX</span>
              <span className="brand-tag">RESEARCH AGENT</span>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={onToggle}
            title={isOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            {isOpen ? "«" : "»"}
          </button>
        </div>

        {/* New Investigation Action */}
        <div className="sidebar-action-wrap">
          <button
            type="button"
            className="btn-new-investigation"
            onClick={onNewInvestigation}
            title="Start new research investigation"
          >
            <span className="plus-icon">+</span>
            <span>New Investigation</span>
          </button>
        </div>

        {/* Recent Investigations List */}
        <div className="sidebar-scrollable">
          <div className="recent-header">
            <span className="recent-label">Recent Inquiries</span>
            {recentSearches.length > 0 && (
              <button
                type="button"
                className="btn-clear-history"
                onClick={onClearHistory}
                title="Clear recent history"
              >
                Clear
              </button>
            )}
          </div>

          {recentSearches.length === 0 ? (
            <div className="recent-empty">
              <span className="empty-spark">✦</span>
              <p>No recent inquiries yet. Inquiries will appear here as you investigate.</p>
            </div>
          ) : (
            <ul className="recent-list">
              {recentSearches.map((item) => (
                <li key={item.id} className="recent-item">
                  <button
                    type="button"
                    className="recent-link"
                    onClick={() => onSelectRecent(item)}
                    title={item.title}
                  >
                    <span className="recent-icon">{item.deepResearch ? "✦" : "💬"}</span>
                    <span className="recent-text">{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Capabilities & Status Footer */}
        <div className="sidebar-footer">
          <div className="system-status">
            <span className="status-dot-live" />
            <div className="status-info">
              <span className="status-title">Autonomous Core</span>
              <span className="status-sub">Online · Live Search Ready</span>
            </div>
          </div>

          <div className="sidebar-footer-controls">
            <button
              type="button"
              className="theme-switch-btn"
              onClick={onToggleTheme}
              title={`Switch to ${theme === "light" ? "Dark" : "Light"} mode`}
            >
              <span className="theme-icon">{theme === "light" ? "🌙" : "☀️"}</span>
              <span className="theme-text">{theme === "light" ? "Dark mode" : "Light mode"}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

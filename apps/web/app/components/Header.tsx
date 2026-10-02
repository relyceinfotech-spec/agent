"use client";

import React from "react";
import Link from "next/link";

interface HeaderProps {
  onToggleSidebar: () => void;
  activeTitle?: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNewInvestigation: () => void;
  userEmail?: string;
  onSignOut: () => void;
}

export function Header({
  onToggleSidebar,
  activeTitle,
  theme,
  onToggleTheme,
  onNewInvestigation,
  userEmail,
  onSignOut,
}: HeaderProps) {
  return (
    <header className="workspace-header">
      <div className="header-left">
        <button
          type="button"
          className="header-menu-btn"
          onClick={onToggleSidebar}
          title="Toggle navigation sidebar"
          aria-label="Toggle navigation sidebar"
        >
          <span className="hamburger-bar" />
          <span className="hamburger-bar" />
          <span className="hamburger-bar" />
        </button>

        <div className="header-breadcrumbs">
          <span className="header-brand-mark">✦ MAX</span>
          <span className="header-sep">/</span>
          <span className="header-current-title">
            {activeTitle ? activeTitle : "Autonomous Investigation"}
          </span>
        </div>
      </div>

      <div className="header-right">
        <Link className="header-discover-link" href="/discover">
          Discover
        </Link>
        <div className="header-capabilities">
          <span className="cap-pill" title="Autonomous Routing">
            ⚡ Direct
          </span>
          <span className="cap-pill" title="Live Google Search via Serper">
            🌐 Live Search
          </span>
          <span className="cap-pill" title="Multi-Source Evidence Verification">
            ⚖️ Verified
          </span>
        </div>

        <button
          type="button"
          className="header-action-btn"
          onClick={onNewInvestigation}
          title="Start fresh investigation"
        >
          <span className="action-icon">+</span>
          <span className="action-label">New</span>
        </button>

        <div className="header-account">
          <span title={userEmail}>{userEmail || "Signed in"}</span>
          <button type="button" className="header-signout-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        <button
          type="button"
          className="header-theme-btn"
          onClick={onToggleTheme}
          title={`Switch to ${theme === "light" ? "Dark" : "Light"} mode`}
          aria-label={`Switch to ${theme === "light" ? "Dark" : "Light"} mode`}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>
      </div>
    </header>
  );
}

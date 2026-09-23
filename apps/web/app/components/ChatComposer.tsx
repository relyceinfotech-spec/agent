"use client";

import React, { FormEvent, KeyboardEvent, useRef } from "react";

interface ChatComposerProps {
  input: string;
  onChangeInput: (val: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  deepResearch: boolean;
  onToggleDeepResearch: () => void;
  isBusy: boolean;
}

export function ChatComposer({
  input,
  onChangeInput,
  onSubmit,
  onStop,
  deepResearch,
  onToggleDeepResearch,
  isBusy,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isBusy && input.trim()) {
        onSubmit();
      }
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isBusy && input.trim()) {
      onSubmit();
    }
  }

  return (
    <div className="composer-dock-container">
      <form className="composer-card" onSubmit={handleFormSubmit}>
        {/* Main Input Textarea */}
        <div className="composer-input-row">
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask MAX anything... (English, Tanglish, தமிழ், हिन्दी)"
            rows={1}
            disabled={isBusy}
            aria-label="Research inquiry input"
          />
        </div>

        {/* Toolbar & Actions */}
        <div className="composer-toolbar">
          <div className="toolbar-left">
            {/* Deep Research Toggle */}
            <button
              type="button"
              className={`btn-deep-research-toggle ${deepResearch ? "active" : ""}`}
              onClick={onToggleDeepResearch}
              disabled={isBusy}
              title={
                deepResearch
                  ? "✦ Deep Research enabled: Autonomous multi-query evidence verification"
                  : "Enable Deep Research for intensive multi-source investigation"
              }
              aria-pressed={deepResearch}
            >
              <span className="toggle-spark">✦</span>
              <span className="toggle-text">
                {deepResearch ? "Deep Research Active" : "Deep Research"}
              </span>
            </button>

            <span className="composer-keyboard-hint">
              <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
            </span>
          </div>

          <div className="toolbar-right">
            {isBusy ? (
              <button
                type="button"
                className="btn-composer-stop"
                onClick={onStop}
                title="Halt current investigation"
              >
                <span className="stop-square">■</span>
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                className="btn-composer-send"
                disabled={!input.trim()}
                title="Send inquiry"
                aria-label="Send inquiry"
              >
                <span className="send-arrow">↑</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

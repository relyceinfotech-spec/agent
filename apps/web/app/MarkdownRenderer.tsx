"use client";

import React, { useState } from "react";

interface MarkdownRendererProps {
  content: string;
  onCitationClick?: (index: number) => void;
}

/**
 * Premium, zero-dependency Markdown & Citation renderer for Research Agent MAX.
 * Features:
 * - Fenced code blocks with language badge and interactive clipboard copy
 * - Headings (H1 to H4) with clean anchor styling
 * - Callout quotes and blockquotes
 * - Responsive markdown tables
 * - Bullet and numbered lists
 * - Bold, italic, inline code, links
 * - Clickable citation tags [1], [2] with smooth scroll triggers
 */
export function MarkdownRenderer({ content, onCitationClick }: MarkdownRendererProps) {
  if (!content) return null;

  const blocks = parseBlocks(content);

  return (
    <div className="prose-content">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case "code":
            return <CodeBlockView key={idx} lang={block.lang} code={block.text} />;
          case "h1":
            return (
              <h2 key={idx} className="prose-h1">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </h2>
            );
          case "h2":
            return (
              <h3 key={idx} className="prose-h2">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </h3>
            );
          case "h3":
            return (
              <h4 key={idx} className="prose-h3">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </h4>
            );
          case "h4":
            return (
              <h5 key={idx} className="prose-h4">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </h5>
            );
          case "hr":
            return <hr key={idx} className="prose-hr" />;
          case "table":
            return <TableView key={idx} raw={block.text} />;
          case "blockquote":
            return (
              <blockquote key={idx} className="prose-blockquote">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </blockquote>
            );
          case "ul":
            return (
              <ul key={idx} className="prose-ul">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx} className="prose-li">
                    <InlineText text={item} onCitationClick={onCitationClick} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={idx} className="prose-ol">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx} className="prose-li">
                    <InlineText text={item} onCitationClick={onCitationClick} />
                  </li>
                ))}
              </ol>
            );
          case "paragraph":
          default:
            return (
              <p key={idx} className="prose-p">
                <InlineText text={block.text} onCitationClick={onCitationClick} />
              </p>
            );
        }
      })}
    </div>
  );
}

// Code Block with Copy Button
function CodeBlockView({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const displayLang = lang.trim() ? lang.toUpperCase() : "CODE";

  return (
    <div className="code-container">
      <div className="code-header">
        <span className="code-lang">{displayLang}</span>
        <button
          type="button"
          className="code-copy-btn"
          onClick={handleCopy}
          title="Copy code to clipboard"
        >
          {copied ? "✓ Copied" : "📋 Copy"}
        </button>
      </div>
      <pre className="code-block">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Markdown Table Component
function TableView({ raw }: { raw: string }) {
  const lines = raw
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return <pre>{raw}</pre>;

  const headers = lines[0]
    .split("|")
    .map((c) => c.trim())
    .filter((_, i, arr) => i !== 0 && i !== arr.length - 1);

  // Skip delimiter row (line 1)
  const rows = lines.slice(2).map((line) =>
    line
      .split("|")
      .map((c) => c.trim())
      .filter((_, i, arr) => i !== 0 && i !== arr.length - 1),
  );

  return (
    <div className="table-responsive">
      <table className="custom-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx}>
                  <InlineText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Parse inline tokens: code, bold, italic, links, citations
export function InlineText({
  text,
  onCitationClick,
}: {
  text: string;
  onCitationClick?: (index: number) => void;
}) {
  const tokenRegex =
    /(\[\d+\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(\*[^*]+\*)/g;

  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];

    if (token.startsWith("[") && token.endsWith("]") && /^\d+$/.test(token.slice(1, -1))) {
      // Citation: [1], [2]
      const num = parseInt(token.slice(1, -1), 10);
      parts.push(
        <button
          key={`${match.index}-cit`}
          type="button"
          className="citation-pill"
          onClick={() => onCitationClick?.(num)}
          title={`View cited source [${num}]`}
        >
          [{num}]
        </button>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      // Inline code
      parts.push(
        <code key={`${match.index}-code`} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      // Bold
      parts.push(<strong key={`${match.index}-bold`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      // Markdown link
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (linkMatch) {
        parts.push(
          <a
            key={`${match.index}-link`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="prose-link"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    } else if (token.startsWith("*") && token.endsWith("*")) {
      // Italic
      parts.push(<em key={`${match.index}-em`}>{token.slice(1, -1)}</em>);
    } else {
      parts.push(token);
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "h1"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "h4"; text: string }
  | { type: "hr" }
  | { type: "table"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "paragraph"; text: string };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check for fenced code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().replace(/^```/, "").trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      continue;
    }

    // Check for empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Check for Horizontal Rule
    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Check for Headings
    if (line.startsWith("#### ")) {
      blocks.push({ type: "h4", text: line.replace(/^####\s+/, "").trim() });
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.replace(/^###\s+/, "").trim() });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.replace(/^##\s+/, "").trim() });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.replace(/^#\s+/, "").trim() });
      i++;
      continue;
    }

    // Check for Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    // Check for Table
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|---")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", text: tableLines.join("\n") });
      continue;
    }

    // Check for Bullet List (- or *)
    if (/^[-*]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Check for Numbered List (1. , 2. )
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Regular Paragraph: collect contiguous non-blank lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith(">") &&
      !/^(\*\*\*|---|___)$/.test(lines[i].trim()) &&
      !(lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|---")) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join(" ") });
    }
  }

  return blocks;
}

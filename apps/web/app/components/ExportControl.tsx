"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "../auth-provider";
import { authenticatedFetch } from "../supabase-browser";
import { getApiBaseUrl } from "../api-url";

const API = getApiBaseUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);

type ExportFormat = "markdown" | "json" | "pdf";

interface ExportControlProps {
  resourceType: "research_session" | "published_post";
  resourceId: string;
  nextPath: string;
}

interface ExportMetadata {
  fileName: string;
  downloadUrl?: string;
}

export function ExportControl({ resourceType, resourceId, nextPath }: ExportControlProps) {
  const { ready, session } = useAuth();
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function createAndDownload() {
    if (!session || working) return;
    setWorking(true);
    setMessage("");
    setError("");
    try {
      const created = await authenticatedFetch(`${API}/api/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceType, resourceId, format }),
      });
      if (!created.ok) {
        throw new Error(
          created.status === 404 || created.status === 403
            ? "This saved item is not available for export from this account."
            : "MAX could not prepare this export. Please try again.",
        );
      }
      const metadata = (await created.json()) as ExportMetadata;
      if (!metadata.downloadUrl || !metadata.fileName) {
        throw new Error("The export is not ready to download.");
      }
      const downloaded = await authenticatedFetch(`${API}${metadata.downloadUrl}`);
      if (!downloaded.ok) throw new Error("MAX could not download this export.");

      const objectUrl = URL.createObjectURL(await downloaded.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = metadata.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setMessage(`${format === "markdown" ? "Markdown" : format.toUpperCase()} download started.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MAX could not prepare this export.");
    } finally {
      setWorking(false);
    }
  }

  if (!ready) return null;
  if (!session) {
    return (
      <Link
        className="btn-artifact-copy export-sign-in"
        href={`/login?next=${encodeURIComponent(nextPath)}`}
      >
        Sign in to export
      </Link>
    );
  }

  return (
    <div className="export-control">
      {/* A native select is intentional: this is a compact, standard three-format choice. */}
      <label className="sr-only" htmlFor={`export-format-${resourceType}-${resourceId}`}>
        Export format
      </label>
      <select
        id={`export-format-${resourceType}-${resourceId}`}
        value={format}
        onChange={(event) => setFormat(event.target.value as ExportFormat)}
        disabled={working}
      >
        <option value="markdown">Markdown</option>
        <option value="json">JSON</option>
        <option value="pdf">PDF</option>
      </select>
      <button
        type="button"
        className="btn-artifact-copy"
        onClick={() => void createAndDownload()}
        disabled={working}
      >
        {working ? "Preparing…" : "Export"}
      </button>
      {message && (
        <span className="export-feedback" role="status">
          {message}
        </span>
      )}
      {error && (
        <span className="export-feedback export-feedback-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

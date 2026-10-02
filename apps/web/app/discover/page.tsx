"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ContentPost } from "../content-types";
import { getApiBaseUrl } from "../api-url";

const API = getApiBaseUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);

export default function DiscoverPage() {
  const [posts, setPosts] = useState<ContentPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("All topics");

  useEffect(() => {
    const theme = localStorage.getItem("max_theme") || "dark";
    document.documentElement.setAttribute("data-theme", theme);
    const controller = new AbortController();
    fetch(`${API}/api/discover`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Research feed unavailable (${response.status})`);
        return response.json() as Promise<ContentPost[]>;
      })
      .then(setPosts)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Could not load research posts");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const categories = useMemo(
    () => ["All topics", ...new Set(posts.map((post) => post.category).filter(Boolean))],
    [posts],
  );
  const visible =
    category === "All topics" ? posts : posts.filter((post) => post.category === category);

  return (
    <main className="content-shell">
      <nav className="content-nav" aria-label="Primary navigation">
        <Link className="content-brand" href="/">
          ✦ MAX
        </Link>
        <div className="content-nav-links">
          <Link href="/">Research</Link>
          <span aria-current="page">Discover</span>
          <Link href="/login">Sign in</Link>
        </div>
      </nav>

      <section className="content-hero">
        <p className="content-eyebrow">AUTONOMOUS RESEARCH · VERIFIED BEFORE PUBLICATION</p>
        <h1>Discover what MAX is investigating.</h1>
        <p>
          Research-backed findings selected from timely sources. Every published post links back to
          the evidence MAX used.
        </p>
      </section>

      {categories.length > 1 && (
        <div className="content-filters" aria-label="Filter by category">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              className={category === item ? "selected" : ""}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="content-state" role="status">
          Loading published research…
        </div>
      )}
      {error && (
        <div className="content-state error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div className="content-state">
          <h2>No published research yet</h2>
          <p>
            MAX only publishes when the source and evidence checks pass. New verified work will
            appear here.
          </p>
        </div>
      )}

      <div className="post-grid">
        {visible.map((post) => (
          <article className="post-card" key={post.id}>
            <div className="post-card-meta">
              <span className="post-category">{post.category || "Research"}</span>
              <time dateTime={post.publishedAt}>
                {new Date(post.publishedAt).toLocaleDateString()}
              </time>
            </div>
            <h2>
              <Link href={`/posts/${post.id}`}>{post.title}</Link>
            </h2>
            <p>{post.summary}</p>
            <div className="post-card-footer">
              <span>✦ Researched by MAX</span>
              <span>
                {post.sources.length} {post.sources.length === 1 ? "source" : "sources"}
              </span>
              <Link href={`/posts/${post.id}`}>Read research →</Link>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

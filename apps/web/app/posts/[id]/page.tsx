"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "../../MarkdownRenderer";
import type { ContentPost, PostFollowUp } from "../../content-types";
import { useAuth } from "../../auth-provider";
import { authenticatedFetch } from "../../supabase-browser";
import { ExportControl } from "../../components/ExportControl";
import { getApiBaseUrl } from "../../api-url";

const API = getApiBaseUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);

export default function ResearchPostPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [post, setPost] = useState<ContentPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [followUp, setFollowUp] = useState<PostFollowUp | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      localStorage.getItem("max_theme") || "dark",
    );
    const controller = new AbortController();
    fetch(`${API}/api/posts/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Research post not found"
              : "Could not load this research post",
          );
        return response.json() as Promise<ContentPost>;
      })
      .then(setPost)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Could not load research post");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!followUp || !session || ["COMPLETED", "FAILED"].includes(followUp.status)) return;
    let active = true;
    const deadline = Date.now() + 240_000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setAsking(false);
        clearInterval(timer);
        return;
      }
      authenticatedFetch(
        `${API}/api/posts/${encodeURIComponent(id)}/ask/${encodeURIComponent(followUp.id)}`,
      )
        .then((response) => response.json() as Promise<PostFollowUp>)
        .then((result) => {
          if (!active) return;
          setFollowUp(result);
          if (["COMPLETED", "FAILED"].includes(result.status)) setAsking(false);
        })
        .catch(() => {
          /* next poll can recover from a transient network error */
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, followUp, session?.user.id]);

  async function askQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || asking) return;
    if (!session) {
      router.push(`/login?next=${encodeURIComponent(`/posts/${id}`)}`);
      return;
    }
    setAsking(true);
    setFollowUp(null);
    try {
      const response = await authenticatedFetch(`${API}/api/posts/${encodeURIComponent(id)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      if (!response.ok) throw new Error(`Could not start follow-up (${response.status})`);
      setFollowUp((await response.json()) as PostFollowUp);
    } catch (reason) {
      setFollowUp({
        id: "error",
        postId: id,
        question,
        status: "FAILED",
        usedLiveResearch: false,
        error: reason instanceof Error ? reason.message : "Follow-up failed",
      });
      setAsking(false);
    }
  }

  const citationSources = followUp?.sources?.length
    ? followUp.sources.map((source, index) => ({
        key: source.id,
        citation: index + 1,
        title: source.title,
        url: source.url,
      }))
    : (post?.sources.map((source) => ({
        key: String(source.citation),
        citation: source.citation,
        title: source.title,
        url: source.url,
      })) ?? []);

  return (
    <main className="content-shell">
      <nav className="content-nav" aria-label="Primary navigation">
        <Link className="content-brand" href="/">
          ✦ MAX
        </Link>
        <div className="content-nav-links">
          <Link href="/">Research</Link>
          <Link href="/discover">Discover</Link>
        </div>
      </nav>
      <p className="content-back">
        <Link href="/discover">← Back to Discover</Link>
      </p>
      {loading && (
        <div className="content-state" role="status">
          Loading research artifact…
        </div>
      )}
      {error && (
        <div className="content-state error" role="alert">
          {error}
        </div>
      )}
      {post && (
        <article className="research-post">
          <div className="post-card-meta">
            <span className="post-category">{post.category || "Research"}</span>
            <span>✦ Researched by MAX</span>
          </div>
          <h1>{post.title}</h1>
          <p className="post-lead">{post.summary}</p>
          <div className="post-export-row">
            <ExportControl
              resourceType="published_post"
              resourceId={post.id}
              nextPath={`/posts/${id}`}
            />
            <span>Exports are available only to the owner of the published research.</span>
          </div>
          <div className="post-proof-strip">
            <span>
              {post.sources.length} retrieved {post.sources.length === 1 ? "source" : "sources"}
            </span>
            <span>
              {post.findings.length} verified {post.findings.length === 1 ? "finding" : "findings"}
            </span>
            <time dateTime={post.researchedAt}>
              Researched {new Date(post.researchedAt).toLocaleString()}
            </time>
          </div>

          <section className="post-section">
            <h2>Key findings</h2>
            <div className="finding-list">
              {post.findings.map((finding, index) => (
                <div className="finding" key={`${index}:${finding.text}`}>
                  <p>{finding.text}</p>
                  <div className="finding-citations">
                    {finding.citations.map((citation) => {
                      const sourceAvailable = post.sources.some(
                        (source) => source.citation === citation,
                      );
                      return sourceAvailable ? (
                        <a key={citation} href={`#source-${citation}`}>
                          Source {citation}
                        </a>
                      ) : null;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="post-section">
            <h2>Why it matters</h2>
            <p>{post.whyItMatters}</p>
          </section>
          {post.caveats.length > 0 && (
            <section className="post-section post-caveats">
              <h2>Caveats and open questions</h2>
              <ul>
                {post.caveats.map((caveat, index) => (
                  <li key={index}>{caveat}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="post-section" id="post-sources">
            <h2>Sources and provenance</h2>
            <ol className="post-source-list">
              {post.sources.map((source) => (
                <li key={source.citation} id={`source-${source.citation}`}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">
                    {source.title || source.url}
                  </a>
                  <span>
                    {source.domain ?? new URL(source.url).hostname} · {source.sourceType ?? "web"}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="post-followup post-section">
            <h2>Ask about this research</h2>
            <p>
              MAX checks the saved evidence first, then continues live research if the question
              needs more.
            </p>
            {!session && (
              <p>
                <Link href={`/login?next=${encodeURIComponent(`/posts/${id}`)}`}>Sign in</Link> to
                ask a follow-up.
              </p>
            )}
            <form onSubmit={askQuestion}>
              <label className="sr-only" htmlFor="post-question">
                Your question
              </label>
              <input
                id="post-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What does this evidence mean for…?"
                maxLength={1000}
                required
              />
              <button type="submit" disabled={!session || asking || question.trim().length < 4}>
                Ask MAX
              </button>
            </form>
            {followUp && (
              <div className="followup-result" aria-live="polite">
                <p className="followup-status">
                  {followUp.status === "COMPLETED"
                    ? followUp.usedLiveResearch
                      ? "Saved evidence + live research"
                      : "Answered from saved research"
                    : followUp.status === "FAILED"
                      ? "Follow-up failed"
                      : `MAX is ${followUp.status.toLowerCase()}…`}
                </p>
                {followUp.error && <p role="alert">{followUp.error}</p>}
                {followUp.answer && (
                  <MarkdownRenderer
                    content={followUp.answer}
                    onCitationClick={(index) =>
                      document
                        .getElementById(`followup-source-${index}`)
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  />
                )}
                {followUp.answer && (
                  <ol className="post-source-list">
                    {citationSources.map((source, index) => (
                      <li key={source.key} id={`followup-source-${index + 1}`}>
                        <a href={source.url} target="_blank" rel="noopener noreferrer">
                          [{index + 1}] {source.title || source.url}
                        </a>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </section>
        </article>
      )}
    </main>
  );
}

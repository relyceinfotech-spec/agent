import { describe, expect, it } from "vitest";
import {
  extractFeed,
  extractHtml,
  extractRetrievedDocument,
  validateExtraction,
} from "../src/extract.js";
import {
  isRetryableFetchStatus,
  readBoundedBytes,
  readBoundedText,
  retryTransient,
} from "../src/security.js";
import { extractPdf } from "../src/pdf.js";
import { retrieveSource } from "../src/source-retrieval.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { OpenRouterProvider } from "../src/llm.js";
import type { Claim, Source } from "../src/domain.js";

function samplePdf(text: string): Uint8Array {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > 65) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  const stream = `BT /F1 12 Tf 72 700 Td ${lines
    .map((part, index) => `${index ? "0 -20 Td " : ""}(${part}) Tj`)
    .join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe("source retrieval and extraction safety", () => {
  it("retries transient fetch errors once but does not retry permanent failures", async () => {
    let attempts = 0;
    const result = await retryTransient(async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return "retrieved";
    });
    expect(result).toBe("retrieved");
    expect(attempts).toBe(2);
    expect(isRetryableFetchStatus(503)).toBe(true);
    expect(isRetryableFetchStatus(429)).toBe(true);
    expect(isRetryableFetchStatus(404)).toBe(false);

    attempts = 0;
    await expect(
      retryTransient(async () => {
        attempts += 1;
        throw new Error("Blocked private IP destination");
      }),
    ).rejects.toThrow("Blocked private IP destination");
    expect(attempts).toBe(1);
  });

  it("parses npm text/plain package metadata as structured version evidence", () => {
    const document = extractRetrievedDocument(
      JSON.stringify({
        name: "react",
        version: "19.3.0",
        description: "React is a JavaScript library for building user interfaces.",
      }),
      new URL("https://registry.npmjs.org/react/latest"),
      "text/plain",
    );
    validateExtraction(document);
    expect(document.contentType).toBe("structured");
    expect(document.content).toContain("Published version or release tag: 19.3.0");
  });

  it("rejects short JavaScript shells and challenge pages as evidence", () => {
    const url = new URL("https://example.org/article");
    const shell = extractHtml(
      "<html><body><div id='root'></div><script src='/app.js'></script></body></html>",
      url,
    );
    expect(() => validateExtraction(shell)).toThrow("too short");

    const challenge = extractHtml(
      `<html><body><main>${"Verify you are human to continue. ".repeat(10)}</main></body></html>`,
      url,
    );
    expect(() => validateExtraction(challenge)).toThrow("challenge");
  });

  it("reads relevant article paragraphs instead of treating navigation clutter as claims", async () => {
    const document = extractHtml(
      `<html><body><article><div>CoursesTutorialsPracticeJobsDSAPractice ProblemsC C++JavaPythonJavaScriptData ScienceMachine LearningCoursesLinuxDevOpsShare Your Experiences</div>
       <p>This comparison introduces two mobile frameworks and explains that project priorities vary across teams.</p>
       <p>Flutter and React Native have different rendering architectures, which affects performance profiling and developer workflow in production applications.</p></article></body></html>`,
      new URL("https://example.org/mobile-comparison"),
    );
    validateExtraction(document);
    expect(document.content).not.toContain("CoursesTutorialsPracticeJobs");
    const source: Source = {
      id: "source-1",
      title: "Mobile comparison",
      url: "https://example.org/mobile-comparison",
      snippet: "Mobile frameworks",
      domain: "example.org",
      content: document.content,
      quality: { relevance: 0.9, authority: 0.7, freshness: 0.8, completeness: 0.8, overall: 0.8 },
    };
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const claims = (await registry.execute("extract_claims", {
      sources: [source],
      question: "Compare Flutter and React Native performance",
    })) as Claim[];
    expect(claims[0].text).toContain("Flutter and React Native");
    expect(claims.every((claim) => !claim.text.includes("CoursesTutorials"))).toBe(true);
    expect(claims[0].evidence).toBe(claims[0].text);
  });

  it("prefers the explicit article body over an earlier recommendation card", () => {
    const document = extractHtml(
      `<html><body>
        <article class="recommendation">
          <h2>Recommended reading</h2>
          <p>This short recommendation card describes another GitHub engineering story.</p>
        </article>
        <main>
          <section class="post__content">
            <h1>Rendering huge pull requests in the GitHub Copilot app</h1>
            <p>The GitHub Copilot app needs to render pull requests with thousands of changed files while keeping navigation responsive for developers.</p>
            <p>The team redesigned the rendering strategy to reduce unnecessary work and improve the experience when inspecting large code changes.</p>
            <p>These implementation details explain how the application handles substantial pull request data without blocking the user interface.</p>
          </section>
        </main>
      </body></html>`,
      new URL("https://github.blog/engineering/user-experience/large-pull-requests"),
    );

    validateExtraction(document);
    expect(document.content).toContain("thousands of changed files");
    expect(document.content).not.toContain("short recommendation card");
  });

  it("filters navigation, promotional filler, and mismatched-script passages from claims", async () => {
    const source: Source = {
      id: "flutter-docs",
      title: "Flutter performance",
      url: "https://docs.flutter.dev/perf",
      snippet: "Performance",
      domain: "docs.flutter.dev",
      content: [
        "(Alternatively, you can check the Flutter GitHub issue database using the performance label.)",
        'Watch on YouTube in a new tab: "Flutter performance tips | Flutter in Focus"',
        "Our aim is to give developers a Firebase-like developer experience using open source tools.",
        "이 페이지는 Firebase 인증을 사용하여 사용자 계정을 관리합니다.",
        "Flutter performance profiling can identify frame rendering delays and excessive memory usage in production applications.",
      ].join("\n"),
      quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
    };
    const registry = createToolRegistry({ search: async () => [] }, new OpenRouterProvider());
    const claims = (await registry.execute("extract_claims", {
      sources: [source],
      question: "Compare Flutter performance profiling and memory usage",
    })) as Claim[];
    expect(claims.map((claim) => claim.text)).toEqual([
      "Flutter performance profiling can identify frame rendering delays and excessive memory usage in production applications.",
    ]);
  });

  it("extracts a structured feed and labels its content type", () => {
    const xml = `<rss><channel><title>Example News</title><description>Updates</description>
      <item><title>First story</title><description>${"Detailed original reporting. ".repeat(8)}</description></item>
      <item><title>Second story</title><description>${"Another documented update. ".repeat(8)}</description></item>
    </channel></rss>`;
    const document = extractFeed(xml, new URL("https://example.org/feed.xml"));
    validateExtraction(document);
    expect(document).toMatchObject({
      title: "Example News",
      contentType: "rss",
      headings: ["First story", "Second story"],
    });
  });

  it("enforces actual body size and decodes the declared charset", async () => {
    const tooLarge = new Response("123456789", { headers: { "content-length": "2" } });
    await expect(readBoundedText(tooLarge, 5, 1000)).rejects.toThrow("content-size limit");

    const latin1 = new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
    });
    expect(await readBoundedText(latin1, 100, 1000)).toBe("café");

    const binary = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(await readBoundedBytes(binary, 10, 1000)).toEqual(Buffer.from("%PDF"));
  });

  it("extracts and validates selectable PDF text", async () => {
    const statement =
      "This research document contains a reproducible benchmark and a detailed explanation of its evidence and limitations for readers. The method compares several independent observations and explains the uncertainty in each result.";
    const document = await extractPdf(
      samplePdf(statement),
      new URL("https://example.org/report.pdf"),
    );
    validateExtraction(document);
    expect(document.content).toContain("reproducible benchmark");
    expect(document.contentType).toBe("pdf");
  });

  it("retrieves a PDF identified by content type at an extensionless URL", async () => {
    const url = "https://example.org/download?id=report";
    const bytes = samplePdf(
      "This research document contains a reproducible benchmark and detailed evidence for the results. The method compares independent observations and explains uncertainty and limitations for readers.",
    );
    let browserCalls = 0;
    const retrieved = await retrieveSource(
      {
        question: "Explain the benchmark results",
        allowSnippetEvidence: false,
        result: { title: "Benchmark report", url, snippet: "Research results" },
      },
      {
        fetch: async (_url, init) => ({
          url,
          response: new Response(init?.method === "HEAD" ? null : bytes, {
            headers: { "content-type": "application/pdf" },
          }),
          dispose: async () => {},
        }),
        browser: async () => {
          browserCalls++;
          throw new Error("PDF should not launch a browser");
        },
      },
    );
    expect(retrieved.retrievalMethod).toBe("pdf");
    expect(retrieved.document.content).toContain("reproducible benchmark");
    expect(browserCalls).toBe(0);
  });
});

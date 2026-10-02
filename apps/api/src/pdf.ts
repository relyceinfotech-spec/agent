import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ExtractedDocument } from "./extract.js";

/** Extract selectable text from a bounded PDF. Scanned PDFs fail validation downstream. */
export async function extractPdf(bytes: Uint8Array, url: URL): Promise<ExtractedDocument> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= Math.min(pdf.numPages, 20); number++) {
      const page = await pdf.getPage(number);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      page.cleanup();
      if (pages.join(" ").length > 100_000) break;
    }
    const title = decodeURIComponent(url.pathname.split("/").pop() || "PDF document")
      .replace(/\.pdf$/i, "")
      .replace(/[-_]+/g, " ");
    return {
      title,
      description: "",
      domain: url.hostname,
      content: pages.join("\n\n").replace(/\s+/g, " ").slice(0, 100_000).trim(),
      headings: [],
      contentType: "pdf",
    };
  } finally {
    await task.destroy();
  }
}

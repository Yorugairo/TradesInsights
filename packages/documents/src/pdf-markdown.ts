import { readFile, rm, writeFile } from "node:fs/promises";
import {
  extractPdfTextItems,
  groupIntoLines,
  type PdfPageText,
  type PdfTextItem,
} from "./pdf.js";

/**
 * PDF → Markdown/text conversion for the local *download* workflow.
 *
 * This is a byte-shrinking convenience for operator-downloaded PDFs (permit
 * agendas, SEPA determinations, Exago report exports): a 2 MB scanned-layout
 * PDF becomes a few KB of readable text that a human — or a downstream text
 * extractor — can work with, and the bloated original is discarded.
 *
 * IMPORTANT — this is NOT the source-pipeline raw-storage path. Adapters MUST
 * still store the immutable raw artifact bytes in the ObjectStore *before*
 * parsing (spec §5, "never parse-then-store"). This converter only touches
 * transient on-disk scratch downloads; it never stands in for immutable raw
 * evidence.
 */

/** Horizontal gap (viewport points) above which two items on the same visual
 * line are treated as separate columns and joined with a wider space. Below it
 * they are one phrase joined by a single space. 24pt ≈ a few character widths
 * at body sizes — wide enough to keep words together, narrow enough to keep
 * table columns apart. */
const COLUMN_GAP = 24;

/** Render one visual line's items to a string, preserving column breaks as a
 * ` | ` separator so table rows stay legible in the markdown. */
function lineToText(items: PdfTextItem[]): string {
  let out = "";
  let prevX: number | null = null;
  for (const it of items) {
    if (prevX === null) {
      out = it.text;
    } else if (it.x - prevX > COLUMN_GAP) {
      out += ` | ${it.text}`;
    } else {
      out += ` ${it.text}`;
    }
    prevX = it.x;
  }
  return out.replace(/\s+\|\s+$/g, "").trim();
}

/**
 * Convert already-extracted positioned page text to markdown. Split out from
 * {@link pdfToMarkdown} so callers that already hold the extracted pages (e.g.
 * an adapter that also parses them structurally) don't re-run pdfjs.
 */
export function pagesToMarkdown(pages: PdfPageText[]): string {
  const blocks: string[] = [];
  for (const page of pages) {
    const lines = groupIntoLines(page.items)
      .map((l) => lineToText(l.items))
      .filter((t) => t.length > 0);
    const heading = pages.length > 1 ? `## Page ${page.pageNumber}\n\n` : "";
    blocks.push(`${heading}${lines.join("\n")}`);
  }
  // Trailing newline so concatenated files diff cleanly.
  return `${blocks.join("\n\n").trimEnd()}\n`;
}

/** Convert PDF bytes to markdown/plain text. Reuses the repo's pdfjs-backed
 * positioned-text extractor, so it inherits rotation handling (landscape
 * permit tables read in reading order). */
export async function pdfToMarkdown(data: Buffer): Promise<string> {
  const pages = await extractPdfTextItems(data);
  return pagesToMarkdown(pages);
}

export interface PdfConversionResult {
  markdownPath: string;
  markdown: string;
  /** Size of the original PDF on disk, bytes. */
  pdfBytes: number;
  /** Size of the produced markdown, bytes. */
  markdownBytes: number;
}

/**
 * Read a downloaded PDF, write a sibling `.md`, and delete the original PDF
 * (the "convert then drop the bloated PDF" download step). Set
 * `keepPdf: true` to retain the source (e.g. while validating the converter).
 *
 * The `.md` path replaces a trailing `.pdf` (case-insensitive); a path with no
 * `.pdf` extension gets `.md` appended.
 */
export async function convertPdfFileToMarkdown(
  pdfPath: string,
  opts?: { keepPdf?: boolean },
): Promise<PdfConversionResult> {
  const buf = await readFile(pdfPath);
  const markdown = await pdfToMarkdown(buf);
  const markdownPath = /\.pdf$/i.test(pdfPath)
    ? pdfPath.replace(/\.pdf$/i, ".md")
    : `${pdfPath}.md`;
  await writeFile(markdownPath, markdown, "utf8");
  const result: PdfConversionResult = {
    markdownPath,
    markdown,
    pdfBytes: buf.byteLength,
    markdownBytes: Buffer.byteLength(markdown, "utf8"),
  };
  // Only drop the original after the markdown is safely on disk.
  if (!opts?.keepPdf) await rm(pdfPath, { force: true });
  return result;
}

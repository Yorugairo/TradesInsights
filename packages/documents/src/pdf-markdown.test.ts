import { access, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertPdfFileToMarkdown, pdfToMarkdown } from "./pdf-markdown.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);
const JUNE = join(
  FIXTURES_DIR,
  "lacey_permit_reports",
  "June-2026-Census-Report-New-Construction.pdf",
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("pdfToMarkdown", () => {
  it("renders the real permit-census PDF as legible text", async () => {
    const md = await pdfToMarkdown(await readFile(JUNE));
    // Content the human reads off the report survives conversion. The footer
    // label wraps across a column and a line in the source PDF
    // ("Total Number of | 14" / "Permits Issued"), so assert the pieces, not a
    // contiguous phrase the layout never contained.
    expect(md).toContain("BLDG25-0787");
    expect(md).toContain("Total Number of");
    expect(md).toContain("Permits Issued");
    // Column-separated table cells keep a visible break (site address column).
    expect(md).toMatch(/CARPENTER RD SE/);
    expect(md).toContain("## Page 2"); // multi-page docs get page headings
    expect(md.length).toBeGreaterThan(200);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("is deterministic across runs (same bytes → same markdown)", async () => {
    const bytes = await readFile(JUNE);
    const a = await pdfToMarkdown(bytes);
    const b = await pdfToMarkdown(bytes);
    expect(a).toBe(b);
  });
});

describe("convertPdfFileToMarkdown (download → convert → discard)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "otn-pdfmd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a sibling .md, drops the PDF, and shrinks bytes", async () => {
    const pdfPath = join(dir, "download.pdf");
    await copyFile(JUNE, pdfPath);

    const res = await convertPdfFileToMarkdown(pdfPath);

    expect(res.markdownPath).toBe(join(dir, "download.md"));
    expect(await exists(res.markdownPath)).toBe(true);
    expect(await exists(pdfPath)).toBe(false); // bloated original deleted
    expect(res.markdownBytes).toBeGreaterThan(0);
    expect(res.markdownBytes).toBeLessThan(res.pdfBytes); // text is smaller than the PDF
    expect(await readFile(res.markdownPath, "utf8")).toContain("BLDG25-0787");
  });

  it("keepPdf:true retains the original", async () => {
    const pdfPath = join(dir, "keep.pdf");
    await copyFile(JUNE, pdfPath);

    await convertPdfFileToMarkdown(pdfPath, { keepPdf: true });

    expect(await exists(pdfPath)).toBe(true);
    expect(await exists(join(dir, "keep.md"))).toBe(true);
  });
});

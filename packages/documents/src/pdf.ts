import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfTextItem {
  text: string;
  /** Viewport (display) coordinates — page rotation already applied. */
  x: number;
  y: number;
}

export interface PdfPageText {
  pageNumber: number;
  items: PdfTextItem[];
}

/**
 * Positioned text extraction (spec §2 documents package). Coordinates are
 * mapped through the page viewport so rotated pages (e.g. landscape permit
 * tables) come out in reading orientation: y grows downward, x rightward.
 */
export async function extractPdfTextItems(data: Buffer): Promise<PdfPageText[]> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  }).promise;
  try {
    const pages: PdfPageText[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const [x, y] = viewport.convertToViewportPoint(
          item.transform[4],
          item.transform[5],
        );
        items.push({ text: item.str.trim(), x: Math.round(x), y: Math.round(y) });
      }
      pages.push({ pageNumber: p, items });
    }
    return pages;
  } finally {
    await doc.cleanup?.();
  }
}

/** Group items into visual lines by y proximity (default 4pt), sorted top-to-bottom, left-to-right. */
export function groupIntoLines(
  items: PdfTextItem[],
  tolerance = 4,
): { y: number; items: PdfTextItem[] }[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { y: number; items: PdfTextItem[] }[] = [];
  for (const it of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.y - line.y) <= tolerance) {
      line.items.push(it);
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

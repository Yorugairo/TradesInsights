import ExcelJS from "exceljs";

/** A normalized spreadsheet cell: plain value, with any hyperlink preserved. */
export interface XlsxCell {
  value: string | number | null;
  hyperlink: string | null;
}

export interface XlsxSheet {
  name: string;
  /** 1-indexed rows → 1-indexed cells (index 0 unused, as in ExcelJS). */
  rows: XlsxCell[][];
}

function normalizeCell(v: ExcelJS.CellValue): XlsxCell {
  if (v === null || v === undefined) return { value: null, hyperlink: null };
  if (v instanceof Date) return { value: v.toISOString().slice(0, 10), hyperlink: null };
  if (typeof v === "object") {
    if ("richText" in v) {
      return { value: v.richText.map((t) => t.text).join("").trim(), hyperlink: null };
    }
    if ("text" in v && "hyperlink" in v) {
      const text = typeof v.text === "string" ? v.text : String(v.text ?? "");
      return { value: text.trim(), hyperlink: v.hyperlink ?? null };
    }
    if ("result" in v) return normalizeCell(v.result as ExcelJS.CellValue);
    if ("error" in v) return { value: null, hyperlink: null };
    return { value: String(v), hyperlink: null };
  }
  if (typeof v === "boolean") return { value: v ? "TRUE" : "FALSE", hyperlink: null };
  if (typeof v === "string") {
    const t = v.trim();
    return { value: t === "" ? null : t, hyperlink: null };
  }
  return { value: v, hyperlink: null };
}

/** Read an .xlsx workbook into normalized cells (spec §2 documents package). */
export async function readXlsx(data: Buffer): Promise<XlsxSheet[]> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's Buffer type predates modern @types/node; the runtime accepts a Buffer.
  await wb.xlsx.load(data as never);
  return wb.worksheets.map((ws) => {
    const rows: XlsxCell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: XlsxCell[] = [];
      const values = row.values as ExcelJS.CellValue[];
      for (let c = 0; c < values.length; c++) cells[c] = normalizeCell(values[c]);
      rows[rowNumber] = cells;
    });
    return { name: ws.name, rows };
  });
}

import type { ParsedSourceRecord } from "./types.js";

/**
 * D1 — parser self-reconciliation invariants (sourcing-durability roadmap).
 *
 * Positional PDF/table parsers assign values by geometry. A layout shift can
 * move a column without changing any field name, dropping any volume, or
 * emitting zero records — so the schema fingerprint, volume-drop, and
 * zero-record health checks all stay green while the parser silently produces
 * WRONG values. For a "no claim without a source / never fabricate" product
 * that is the worst failure mode. These invariants let a parser certify its own
 * output against the document's printed totals and against value-shape
 * expectations at RUNTIME (not just in unit tests); the runner records
 * violations and `evaluateSourceHealth` turns them red.
 *
 * Invariants must never fabricate a violation: when the reference value cannot
 * be read (e.g. the printed total is absent), the check returns null.
 */
export interface InvariantViolation {
  /** Stable check id, e.g. "lacey_printed_permit_count". */
  check: string;
  detail: string;
  observed: string | number | null;
  expected: string | number | null;
}

/**
 * Reconcile a document's own printed count (e.g. "Total Number of Permits
 * Issued: 14") against the number of rows the parser produced. A mismatch means
 * the parse dropped or fabricated rows. Returns null when the printed count was
 * not found — an unread total is not evidence of a violation.
 */
export function reconcileCount(
  check: string,
  printed: number | null,
  actual: number,
): InvariantViolation | null {
  if (printed === null) return null;
  if (printed === actual) return null;
  return {
    check,
    detail: `document prints ${printed} rows but parser produced ${actual}`,
    observed: actual,
    expected: printed,
  };
}

/**
 * Reconcile a document's printed numeric total (e.g. a grand-total valuation)
 * against the sum of a parsed field, within an absolute tolerance for rounding.
 * Returns null when the printed total is null.
 */
export function reconcileSum(
  check: string,
  printedTotal: number | null,
  parsedSum: number,
  tolerance = 0.01,
): InvariantViolation | null {
  if (printedTotal === null) return null;
  if (Math.abs(printedTotal - parsedSum) <= tolerance) return null;
  return {
    check,
    detail: `document prints total ${printedTotal} but parsed rows sum to ${parsedSum}`,
    observed: parsedSum,
    expected: printedTotal,
  };
}

/**
 * Every numeric value produced by `get` must fall within [min, max]. A column
 * swap that lands a money value in a unit-count column (or vice-versa) fails
 * this immediately. Nulls are skipped (unknown is not a violation).
 */
export function checkNumericRange(
  records: ParsedSourceRecord[],
  get: (r: ParsedSourceRecord) => number | null,
  opts: { min?: number; max?: number; check: string },
): InvariantViolation | null {
  for (const p of records) {
    const v = get(p);
    if (v === null || !Number.isFinite(v)) continue;
    if (opts.min !== undefined && v < opts.min) {
      return {
        check: opts.check,
        detail: `${p.record.externalId}: value ${v} below floor ${opts.min}`,
        observed: v,
        expected: `>= ${opts.min}`,
      };
    }
    if (opts.max !== undefined && v > opts.max) {
      return {
        check: opts.check,
        detail: `${p.record.externalId}: value ${v} above ceiling ${opts.max}`,
        observed: v,
        expected: `<= ${opts.max}`,
      };
    }
  }
  return null;
}

/**
 * Every ISO date produced by `get` must fall within [minIso, maxIso]. Catches a
 * date column swapped with an adjacent cell. Nulls are skipped.
 */
export function checkDateWindow(
  records: ParsedSourceRecord[],
  get: (r: ParsedSourceRecord) => string | null,
  opts: { minIso: string; maxIso: string; check: string },
): InvariantViolation | null {
  for (const p of records) {
    const iso = get(p);
    if (!iso) continue;
    if (iso < opts.minIso || iso > opts.maxIso) {
      return {
        check: opts.check,
        detail: `${p.record.externalId}: date ${iso} outside [${opts.minIso}, ${opts.maxIso}]`,
        observed: iso,
        expected: `[${opts.minIso}, ${opts.maxIso}]`,
      };
    }
  }
  return null;
}

/**
 * Every string produced by `get` must match `re`. Use for stable id/format
 * shapes (a permit-number column that stops matching its format is drifting).
 * Nulls are skipped.
 */
export function checkPattern(
  records: ParsedSourceRecord[],
  get: (r: ParsedSourceRecord) => string | null,
  opts: { re: RegExp; check: string },
): InvariantViolation | null {
  for (const p of records) {
    const s = get(p);
    if (s === null) continue;
    if (!opts.re.test(s)) {
      return {
        check: opts.check,
        detail: `${p.record.externalId}: "${s}" does not match ${opts.re}`,
        observed: s,
        expected: String(opts.re),
      };
    }
  }
  return null;
}

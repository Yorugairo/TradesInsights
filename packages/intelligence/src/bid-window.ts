/**
 * Drywall bid-window signal (docs/domain-bid-timing.md, customer domain
 * knowledge 2026-07-17). Turns a record's stage + dates into the one line a
 * busy owner acts on: "can I bid this now, and if not, when?"
 *
 * The core inversion:
 * - RESIDENTIAL: drywall bids run ~4–8 weeks AFTER permit issuance (house
 *   framed & dried-in; subs walk the site to measure).
 * - COMMERCIAL: drywall (incl. metal-stud framing) is bought out during plan
 *   review, 2–6 months BEFORE the permit issues (GMP buyout off 90–100% CDs).
 *
 * Every note is phrased as TYPICAL-sequencing language — this is an inference
 * overlay for display, never a fact. It NEVER sets `bidding_confirmed` (spec
 * §9: only an explicit solicitation/invitation confirms bidding); when the
 * stage IS bidding_confirmed, that confirmed fact simply wins.
 */

export type BidTrack = "residential" | "commercial";

export type BidWindowStatus =
  | "confirmed_open" // explicit solicitation/invitation on record (stage fact)
  | "open" // inside the typical bid window for the track
  | "opens_soon" // residential: issued but framing window not reached yet
  | "likely_closed" // typical window has passed / buyout likely done
  | "watch"; // not biddable yet, or not enough dated evidence to say

export interface BidWindow {
  status: BidWindowStatus;
  /** Owner-facing one-liner. Typical-sequencing inference, never a promise. */
  note: string;
  opensAt: Date | null;
  closesAt: Date | null;
}

/**
 * Which sequencing track a project follows, from the deterministic keyword
 * classification (scoring.ts `classify`). Conservative: an explicit SFR signal
 * is residential even when TI-ish interior-remodel wording matches; commercial
 * or multifamily keywords put it on the commercial (pre-permit buyout) track;
 * everything else — the typical unlabeled county house permit — is residential.
 */
export function bidTrackFor(cls: {
  isSfr: boolean;
  isCommercial: boolean;
  isMultifamily: boolean;
}): BidTrack {
  if (cls.isSfr) return "residential";
  if (cls.isCommercial || cls.isMultifamily) return "commercial";
  return "residential";
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type InteriorTrade = "drywall" | "paint";

/**
 * Residential bid windows per trade, in weeks after permit issuance.
 * - drywall: opens ~4 (framing/dried-in), typically closes ~8; "open" is kept
 *   through wk 10 because GCs lock crews 3–4 wks before hanging (~wk 12–14).
 * - paint (a FINISH trade): GCs take bids during framing/drywall, ~6–12; open
 *   kept through wk 14 (application starts ~wk 12–16+ once mud is cured).
 */
const RES_WINDOWS: Record<InteriorTrade, { open: number; close: number; late: number }> = {
  drywall: { open: 4, close: 8, late: 10 },
  paint: { open: 6, close: 12, late: 14 },
};

/** Residential paint execution runs ~12–16 wks post-issuance; midpoint used
 * for the PNW exterior-season check. */
const RES_PAINT_EXEC_MID_WK = 14;

/**
 * PNW exterior constraint: exterior paint needs >50°F and dry surfaces, so an
 * exterior phase landing in Nov–Apr likely stalls (tent-and-heat or wait for
 * spring; interior-only in the meantime). Returns a caveat when the estimated
 * residential paint-execution midpoint falls in that season. Inference only.
 */
function pnwExteriorSeasonCaveat(issuedAt: Date): string | null {
  const execMid = new Date(issuedAt.getTime() + RES_PAINT_EXEC_MID_WK * WEEK_MS);
  const month = execMid.getUTCMonth(); // 0=Jan … 11=Dec
  const wetSeason = month >= 10 || month <= 3; // Nov(10)–Apr(3)
  return wetSeason
    ? " Heads-up: the paint phase likely lands in the Nov–Apr wet season — exterior coats typically stall until warm, dry weather (interior work continues)."
    : null;
}

/** Pre-issuance stages where a commercial GC is running the CD-phase buyout.
 * Exported so the phase-change alert (packages/delivery) fires on the SAME
 * commercial bid window this display overlay reflects — one source of truth. */
export const COMMERCIAL_BUYOUT_STAGES = new Set([
  "preapplication",
  "entitlement",
  "approved",
  "construction_documents",
  "permit_applied",
]);

export function tradeBidWindow(input: {
  trade: InteriorTrade;
  stage: string;
  track: BidTrack;
  /** Latest permit issue date on record, when stated (null otherwise). */
  issuedAt: Date | null;
  /**
   * When the permit APPLICATION was filed, when stated. Optional so every
   * existing call site compiles unchanged and keeps its current wording; the
   * commercial buyout note only sharpens when it is supplied.
   */
  appliedAt?: Date | null;
  now?: Date;
}): BidWindow {
  const now = input.now ?? new Date();
  const { trade, stage, track, issuedAt } = input;
  const appliedAt = input.appliedAt ?? null;
  const win = RES_WINDOWS[trade];
  const range = `${win.open}–${win.close}`;

  // Confirmed facts beat the timing model in both tracks.
  if (stage === "bidding_confirmed") {
    return {
      status: "confirmed_open",
      note: "A bid invitation/solicitation is on record — bid now.",
      opensAt: null,
      closesAt: null,
    };
  }
  if (stage === "withdrawn") {
    return {
      status: "likely_closed",
      note: "Project withdrawn — no bid expected.",
      opensAt: null,
      closesAt: null,
    };
  }

  if (track === "commercial") {
    // Both trades ride the same GMP buyout: bid off the CDs, pre-permit.
    if (COMMERCIAL_BUYOUT_STAGES.has(stage)) {
      // Inside the buyout window the useful distinction is no longer "open vs
      // closed" but HOW FAR IN — a filing from last week and one from last
      // autumn are different calls, and this note used to read identically for
      // both. Phrased as what to DO: "biddable now" left the owner to work out
      // the next action himself.
      const weeksFiled =
        appliedAt === null ? null : Math.floor((now.getTime() - appliedAt.getTime()) / WEEK_MS);
      let note =
        `Commercial ${trade} is typically bought out during plan review, 2–6 months ` +
        "before the permit issues — biddable now while this sits in review.";
      if (weeksFiled !== null) {
        note =
          weeksFiled <= 4
            ? `Filed ~${weeksFiled} week${weeksFiled === 1 ? "" : "s"} ago — invitations to bid typically go out ` +
              "around now. Ask the GC's estimating department for plan-room access before the list closes."
            : weeksFiled <= 12
              ? `In review ~${weeksFiled} weeks — bids are typically being levelled by now. Still worth the ` +
                "call, but expect to be a backup number unless someone dropped out."
              : `In review ~${weeksFiled} weeks. WA commercial land-use routinely runs 4–12+ months, so this can ` +
                "still be a live window — but the buyout may already be done. Confirm before you spend time pricing.";
      }
      return { status: "open", note, opensAt: null, closesAt: null };
    }
    if (stage === "concept" || stage === "unknown") {
      return {
        status: "watch",
        note: `Early stage — commercial ${trade} buyout typically starts once construction documents reach plan review.`,
        opensAt: null,
        closesAt: null,
      };
    }
    // permit_issued / construction / near_final / complete
    return {
      status: "likely_closed",
      note:
        `Commercial ${trade} is typically bought out before the permit issues — likely already ` +
        "let. Addendum pricing is possible if plan-check revisions change the scope." +
        (trade === "paint"
          ? " Paint mobilizes very late (4–12+ months after permit), so a late-package opening is worth watching."
          : ""),
      opensAt: null,
      closesAt: null,
    };
  }

  // Residential track.
  if (stage === "permit_issued" || stage === "construction") {
    if (issuedAt === null) {
      return {
        status: "watch",
        note: `Issue date not stated — residential ${trade} bids typically run ${range} weeks after permit issuance.`,
        opensAt: null,
        closesAt: null,
      };
    }
    const weeks = Math.floor((now.getTime() - issuedAt.getTime()) / WEEK_MS);
    const opensAt = new Date(issuedAt.getTime() + win.open * WEEK_MS);
    const closesAt = new Date(issuedAt.getTime() + win.close * WEEK_MS);
    const seasonCaveat = trade === "paint" ? (pnwExteriorSeasonCaveat(issuedAt) ?? "") : "";
    if (weeks < win.open) {
      const inWeeks = Math.max(1, win.open - weeks);
      const phase = trade === "drywall" ? "Foundation/framing phase" : "Early build phase";
      return {
        status: "opens_soon",
        note: `${phase} — residential ${trade} bids typically open ~${inWeeks} week${inWeeks === 1 ? "" : "s"} from now (${range} weeks after issuance).${seasonCaveat}`,
        opensAt,
        closesAt,
      };
    }
    if (weeks <= win.late) {
      const context =
        trade === "drywall"
          ? "homes are usually framed and dried-in by now"
          : "GCs take paint bids during the framing/drywall phase; painters walk the site before pricing";
      return {
        status: "open",
        note: `Typical bid window is open — ${context} (permit issued ~${weeks} weeks ago; ${range} weeks after issuance is the usual window).${seasonCaveat}`,
        opensAt,
        closesAt,
      };
    }
    return {
      status: "likely_closed",
      note: `Permit issued ~${weeks} weeks ago — the typical ${range} week ${trade} bid window has likely passed.`,
      opensAt,
      closesAt,
    };
  }
  if (stage === "near_final" || stage === "complete") {
    return {
      status: "likely_closed",
      note:
        trade === "paint" && stage === "near_final"
          ? "Late-stage construction — paint is the last finish trade, but the bid was typically let weeks ago."
          : `Late-stage construction — ${trade} was typically let long ago.`,
      opensAt: null,
      closesAt: null,
    };
  }
  // Pre-issuance residential stages (concept … permit_applied, unknown).
  return {
    status: "watch",
    note: `Residential ${trade} bids typically start ${range} weeks AFTER permit issuance — not biddable yet; watch for issuance.`,
    opensAt: null,
    closesAt: null,
  };
}

/** Both Solis trades at once, drywall first (structural before finish). */
export function tradeBidWindows(input: {
  stage: string;
  track: BidTrack;
  issuedAt: Date | null;
  appliedAt?: Date | null;
  now?: Date;
}): ({ trade: InteriorTrade } & BidWindow)[] {
  return (["drywall", "paint"] as const).map((trade) => ({
    trade,
    ...tradeBidWindow({ ...input, trade }),
  }));
}

/**
 * TRADE SCOPING (owner directive 2026-07-22): the windows above encode the
 * INTERIOR-FINISH model Solis stated for drywall + painting. Other trades bid
 * on different clocks (an excavator is pre-permit; an electrician follows
 * rough-in), so a window claim is made ONLY for account capabilities mapped
 * here. An account whose trades have no model gets NO windows — never another
 * trade's borrowed clock. Extend only with customer/owner-stated models.
 */
export const CAPABILITY_TRADE_WINDOWS: Record<string, InteriorTrade> = {
  drywall: "drywall",
  painting: "paint",
  paint: "paint",
};

/** The modeled window trades for an account's capabilities_json list
 * (deduped, drywall first — structural before finish). Empty = no model. */
export function windowTradesFor(capabilities: readonly unknown[]): InteriorTrade[] {
  const out: InteriorTrade[] = [];
  for (const c of capabilities) {
    if (typeof c !== "string") continue;
    const trade = CAPABILITY_TRADE_WINDOWS[c.toLowerCase().trim()];
    if (trade && !out.includes(trade)) out.push(trade);
  }
  return out.sort((a, b) => (a === b ? 0 : a === "drywall" ? -1 : 1));
}

/**
 * The account-scoped bid windows: one entry per MODELED account trade, in the
 * same shape as tradeBidWindows. Empty array when the account holds no modeled
 * trade — callers render nothing (honest empty), never a fallback window.
 */
export function accountBidWindows(
  capabilities: readonly unknown[],
  input: { stage: string; track: BidTrack; issuedAt: Date | null; now?: Date },
): ({ trade: InteriorTrade } & BidWindow)[] {
  return windowTradesFor(capabilities).map((trade) => ({
    trade,
    ...tradeBidWindow({ ...input, trade }),
  }));
}

/** Back-compat name used by earlier tests/callers — the drywall window. */
export function drywallBidWindow(input: {
  stage: string;
  track: BidTrack;
  issuedAt: Date | null;
  now?: Date;
}): BidWindow {
  return tradeBidWindow({ ...input, trade: "drywall" });
}

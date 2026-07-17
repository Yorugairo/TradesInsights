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
/** Residential window: opens 4 wks after issuance, typically closes ~8; we keep
 * "open" through wk 10 because GCs lock crews 3–4 wks before hanging (~wk 12–14). */
const RES_OPEN_WK = 4;
const RES_TYPICAL_CLOSE_WK = 8;
const RES_LATE_WK = 10;

/** Pre-issuance stages where a commercial GC is running the CD-phase buyout. */
const COMMERCIAL_BUYOUT_STAGES = new Set([
  "preapplication",
  "entitlement",
  "approved",
  "construction_documents",
  "permit_applied",
]);

export function drywallBidWindow(input: {
  stage: string;
  track: BidTrack;
  /** Latest permit issue date on record, when stated (null otherwise). */
  issuedAt: Date | null;
  now?: Date;
}): BidWindow {
  const now = input.now ?? new Date();
  const { stage, track, issuedAt } = input;

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
    if (COMMERCIAL_BUYOUT_STAGES.has(stage)) {
      return {
        status: "open",
        note:
          "Commercial drywall is typically bought out during plan review, 2–6 months " +
          "before the permit issues — biddable now while this sits in review.",
        opensAt: null,
        closesAt: null,
      };
    }
    if (stage === "concept" || stage === "unknown") {
      return {
        status: "watch",
        note: "Early stage — commercial drywall buyout typically starts once construction documents reach plan review.",
        opensAt: null,
        closesAt: null,
      };
    }
    // permit_issued / construction / near_final / complete
    return {
      status: "likely_closed",
      note:
        "Commercial drywall is typically bought out before the permit issues — likely already " +
        "let. Addendum pricing is possible if plan-check revisions change the scope.",
      opensAt: null,
      closesAt: null,
    };
  }

  // Residential track.
  if (stage === "permit_issued" || stage === "construction") {
    if (issuedAt === null) {
      return {
        status: "watch",
        note: "Issue date not stated — residential drywall bids typically run 4–8 weeks after permit issuance.",
        opensAt: null,
        closesAt: null,
      };
    }
    const weeks = Math.floor((now.getTime() - issuedAt.getTime()) / WEEK_MS);
    const opensAt = new Date(issuedAt.getTime() + RES_OPEN_WK * WEEK_MS);
    const closesAt = new Date(issuedAt.getTime() + RES_TYPICAL_CLOSE_WK * WEEK_MS);
    if (weeks < RES_OPEN_WK) {
      const inWeeks = Math.max(1, RES_OPEN_WK - weeks);
      return {
        status: "opens_soon",
        note: `Foundation/framing phase — residential drywall bids typically open ~${inWeeks} week${inWeeks === 1 ? "" : "s"} from now (4–8 weeks after issuance).`,
        opensAt,
        closesAt,
      };
    }
    if (weeks <= RES_LATE_WK) {
      return {
        status: "open",
        note: `Typical bid window is open — homes are usually framed and dried-in by now (permit issued ~${weeks} weeks ago; GCs take drywall bids on site 4–8 weeks after issuance).`,
        opensAt,
        closesAt,
      };
    }
    return {
      status: "likely_closed",
      note: `Permit issued ~${weeks} weeks ago — the typical 4–8 week drywall bid window has likely passed.`,
      opensAt,
      closesAt,
    };
  }
  if (stage === "near_final" || stage === "complete") {
    return {
      status: "likely_closed",
      note: "Late-stage construction — drywall was typically let long ago.",
      opensAt: null,
      closesAt: null,
    };
  }
  // Pre-issuance residential stages (concept … permit_applied, unknown).
  return {
    status: "watch",
    note: "Residential drywall bids typically start 4–8 weeks AFTER permit issuance — not biddable yet; watch for issuance.",
    opensAt: null,
    closesAt: null,
  };
}

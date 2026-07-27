import { z } from "zod";

/**
 * The SECOND record class. A solicitation is not a permit and is deliberately
 * not modelled as one (owner decision, 2026-07-27).
 *
 * A permit record answers "who is about to build what, where". A solicitation
 * answers "what work is open for bid, and when does bidding close". The two
 * disagree on every structural axis that matters:
 *
 *   - county is REQUIRED on a permit and routinely ABSENT here (statewide
 *     procurement has no county at all);
 *   - a permit's defining date is application/issue; a solicitation's is the
 *     bid deadline, which has no column in the permit shape;
 *   - a permit ends in "issued"; a solicitation ends in a WINNER.
 *
 * The decisive real case: WEBS row "Maintenance and Service of Gas
 * Chromatography Laboratory Equipment — WSP-RFQQ-GasChro3". No parcel, no
 * building, no jurisdiction, no county. Forced through the permit shape it
 * injects non-construction procurement into the project graph.
 *
 * This schema deliberately does NOT extend or import
 * `NormalizedSourceRecordSchema`. Sharing a base is exactly how the permit
 * shape leaks back in; the four or five overlapping fields are duplicated on
 * purpose.
 *
 * Same governing rule as the permit record: unknown values are null, never
 * guessed and never coerced.
 */

/**
 * Accepts a date or a full datetime — a bid closes at a TIME ("2:00 PM
 * Pacific"), and dropping it silently moves every deadline to midnight.
 */
const IsoDateTimeString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date or datetime string");

/** Lifecycle of a solicitation. Not the permit stage ladder — bids have their own. */
export const SOLICITATION_STATUSES = ["open", "amended", "closed", "awarded"] as const;
export const SolicitationStatusSchema = z.enum(SOLICITATION_STATUSES);
export type SolicitationStatus = z.infer<typeof SolicitationStatusSchema>;

/**
 * `sub_bid_request` is the differentiated signal and must be queryable, not
 * buried in free text: a prime (Skanska, Lease Crutcher Lewis) soliciting subs
 * under WA public-works MWBE/apprenticeship outreach obligations is the only
 * public window into GC bid boards that otherwise live behind BuildingConnected
 * invitation lists. No competing aggregator indexes it.
 */
export const SOLICITATION_DOCUMENT_TYPES = ["solicitation", "sub_bid_request"] as const;
export const SolicitationDocumentTypeSchema = z.enum(SOLICITATION_DOCUMENT_TYPES);
export type SolicitationDocumentType = z.infer<typeof SolicitationDocumentTypeSchema>;

export const NormalizedSolicitationRecordSchema = z
  .object({
    sourceKey: z.string().min(1),
    /** Dedupe key within the source. Mirrors `source_records.external_id`. */
    externalId: z.string().min(1),
    /** The publisher's own number (WEBS reference no., Tacoma spec no.). */
    solicitationNumber: z.string().min(1).nullable(),
    title: z.string().min(1),
    description: z.string().nullable(),
    /**
     * The agency, or the prime running a sub-bid call. The solicitation's
     * analogue of the permit record's `permittingJurisdiction` — keep that
     * reading consistent.
     *
     * NULLABLE, on evidence rather than convenience. The WEBS public bid
     * calendar publishes close date, title, reference number, contact person,
     * amendment date, description, pre-bid conference and inclusion plan — and
     * NOT the procuring organization. That is only on `Search_BidDetails.aspx`,
     * which returns the vendor LOGIN page (verified 2026-07-27). A required
     * field here would force either dropping every WEBS row or inventing an
     * agency, and "never fabricated" outranks schema tidiness.
     */
    procuringAgency: z.string().min(1).nullable(),
    /** Set only for "SUB-BIDS REQUESTED" posts; null for agency solicitations. */
    primeContractor: z.string().min(1).nullable(),
    documentType: SolicitationDocumentTypeSchema,
    /**
     * THE POINT OF THIS RECORD CLASS. First-class and typed, so the deadline
     * can be filtered, sorted and indexed — and so `bid_deadline_changed`
     * (already in EVENT_TYPES) finally has something to diff.
     *
     * NULLABLE but NOT OPTIONAL, and the distinction is load-bearing: the key
     * must be present, so an adapter has to make an explicit decision about the
     * deadline rather than forgetting the field. `null` is a legitimate answer
     * — OMWBE listings are third-party submissions with genuinely missing dates,
     * and emitting the record with a null date beats skipping it or inventing
     * one.
     */
    bidDueAt: IsoDateTimeString.nullable(),
    issuedAt: IsoDateTimeString.nullable(),
    status: SolicitationStatusSchema,
    /**
     * Free string, NOT the permit `CountySchema` enum, and null is a CORRECT
     * value rather than a missing one. Statewide procurement has no county;
     * constraining this to the enum would reintroduce the exact blocker this
     * record class exists to dissolve, forcing adapters to skip every
     * out-of-coverage county. Descriptive only — county-scoped joins still
     * apply to the enum'd permit side.
     */
    county: z.string().min(1).nullable(),
    city: z.string().min(1).nullable(),
    /** Scope of work exactly as published, for trade matching and human review. */
    scopeRaw: z.string().nullable(),
    /** Trade codes derived from the scope. Empty when nothing matched — never guessed. */
    tradeTags: z.array(z.string().min(1)),
    organizations: z.array(
      z.object({
        name: z.string().min(1),
        /** e.g. "prime", "procuring_agency", "contact". */
        role: z.string().nullable(),
        evidenceText: z.string().min(1),
        phone: z.string().min(7).optional(),
        ubi: z.string().min(7).optional(),
        contractorLicense: z.string().min(4).optional(),
        address: z.string().min(5).optional(),
        website: z.string().min(4).optional(),
      }),
    ),
    sourceUrl: z.string().url(),
    evidence: z.array(
      z.object({
        factPath: z.string().min(1),
        text: z.string().min(1),
        pageOrSection: z.string().nullable(),
      }),
    ),
  })
  .strict();

export type NormalizedSolicitationRecord = z.infer<
  typeof NormalizedSolicitationRecordSchema
>;

// NOTE: `project_id` and `observed_at` are columns on `insights.solicitations`
// but deliberately NOT fields here. `observed_at` is the fetch time, which the
// runner already holds; `project_id` is a RESOLUTION-time linkage set only when
// evidence links the bid to a project the graph already knows. A parser that
// could set it would be guessing, and most WEBS rows correctly never link.

import { collapsedText, loadHtml } from "@otn/documents";
import {
  httpFetchArtifact,
  httpGet,
  policyForRun,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedRecord,
  type ParsedSolicitationRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSolicitationRecord } from "@otn/domain";

/**
 * OMWBE bid opportunities — WA's public bid board, and the only public window
 * into GC sub-bid demand.
 *
 * WHY THIS SOURCE. Permits say someone is about to build and you infer bidding.
 * These posts say a bid is OPEN NOW and CLOSES ON A DATE. More valuable still,
 * a subset are prime contractors (Skanska, RAM Construction, Lease Crutcher
 * Lewis) soliciting subs on GC/CM public works under MWBE/apprenticeship
 * outreach obligations — demand that otherwise lives inside BuildingConnected
 * invitation lists, and that no competing aggregator indexes. Those are
 * classified `sub_bid_request` so the class is queryable rather than a
 * substring of a title.
 *
 * URL CORRECTION (2026-07-27). The competitive brief named
 * `/about-omwbe/omwbe-bid-opportunities` as the index. It is not — that page is
 * titled "Contracting with OMWBE" and covers the agency's OWN procurement. The
 * board is `/small-business-assistance/bids-contracting-opportunities`, which
 * carried 160 live postings when this adapter was written.
 *
 * SHAPE. A Drupal view: a two-column table (Project, Closing Date) with the
 * closing date in an RDFa `content` attribute as a real ISO datetime — no
 * US-date parsing needed for discovery. Detail pages at
 * `/bid-opportunities/<slug>` carry the fields worth having:
 * `field-your-organization` (the procuring agency, or the PRIME on a sub-bid
 * post), `field-closing-date`, `field-your-email-address`, and a free-text body.
 *
 * PACING. omwbe.wa.gov publishes `Crawl-delay: 10` (verified 2026-07-27; the
 * board path is not disallowed). At 160 postings that is 27 minutes of fetching,
 * so discovery is CHECKPOINTED: only postings that are new, or whose closing
 * date changed since the last run, are fetched. The first run is capped and
 * warms up over a few days — and the remainder is logged, never silently
 * dropped.
 *
 * DEFENSIVE PARSING. OMWBE states these are third-party submissions "listed as
 * a courtesy". Formatting is inconsistent by design. Every optional field
 * degrades to null; nothing is inferred.
 */

const BOARD_URL =
  "https://omwbe.wa.gov/small-business-assistance/bids-contracting-opportunities";
const ORIGIN = "https://omwbe.wa.gov";

/** robots.txt `Crawl-delay: 10`, verified 2026-07-27. */
const CRAWL_DELAY_MS = 10_000;

/**
 * Detail pages fetched per run. 160 postings x 10s is 27 minutes; 60 keeps a
 * run near 10 and the backlog drains in about three runs. The count skipped is
 * logged every time — a cap that hides what it dropped reads as full coverage.
 */
const MAX_DETAIL_PER_RUN = 60;

/**
 * A sub-bid call from a prime, as opposed to an agency solicitation. Matched on
 * the posting title only, where primes state it explicitly ("SUB-BIDS
 * REQUESTED for GC/CM Project: ...", "Subcontractor Bid Invitation - ...").
 * Body text is not used: an agency ITB routinely mentions subcontracting
 * requirements without being a sub-bid call.
 */
const SUB_BID_TITLE = /\b(sub-?bids?\s+(?:requested|invitation)|subcontractor\s+bid\s+invitation|subcontracting\s+opportunit)/i;

interface BoardEntry {
  slug: string;
  title: string;
  url: string;
  /** ISO datetime from the RDFa `content` attribute, or null when absent. */
  closingIso: string | null;
}

interface Checkpoint {
  /** slug → the closing date last successfully parsed for it. */
  seen?: Record<string, string>;
}

/** Parse the board table. Exported for the fixture test. */
export function parseBoardEntries(html: string | Buffer): BoardEntry[] {
  const $ = loadHtml(html);
  const out: BoardEntry[] = [];
  for (const tr of $("table tr").toArray()) {
    const link = $(tr).find("td.views-field-title a[href]").first();
    const href = link.attr("href");
    if (!href || !href.includes("/bid-opportunities/")) continue;
    const title = collapsedText(link);
    if (!title) continue;
    const slug = href.split("/bid-opportunities/")[1]?.replace(/\/$/, "");
    if (!slug) continue;
    // The RDFa `content` attribute is the machine-readable form; the visible
    // cell is "07/27/26". Prefer the attribute and never reconstruct a
    // two-digit year.
    const closingIso = $(tr).find("[property='dc:date'][content]").first().attr("content") ?? null;
    out.push({
      slug,
      title,
      url: href.startsWith("http") ? href : `${ORIGIN}${href}`,
      closingIso: closingIso && !Number.isNaN(Date.parse(closingIso)) ? closingIso : null,
    });
  }
  return out;
}

/** Read one `field-name-<name>` block's value, minus its own label. */
function fieldValue($: ReturnType<typeof loadHtml>, name: string): string | null {
  const el = $(`.field-name-${name}`).first();
  if (el.length === 0) return null;
  const item = el.find(".field-item").first();
  const text = collapsedText(item.length > 0 ? item : el);
  if (!text) return null;
  // Templates render "Organization:  RAM Construction" — the label is
  // inside the same block on this site.
  const stripped = text.replace(/^[A-Za-z ]{3,30}:\s*/, "").trim();
  return stripped.length > 0 ? stripped : null;
}

export class OmwbeBidOpportunitiesAdapter implements SourceAdapter {
  readonly key = "omwbe_bid_opportunities";
  readonly parserVersion = "1.0.0";

  /** Per-run state; a fresh adapter is constructed for each run. */
  private priorSeen: Record<string, string> = {};
  private confirmed: Record<string, string> = {};

  private policy(ctx: RunContext) {
    // maxConcurrency 1 alongside the delay: spacing request STARTS is
    // meaningless if two are in flight at once.
    return policyForRun(ctx, { maxConcurrency: 1, minIntervalMs: CRAWL_DELAY_MS });
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const body = await httpGet(BOARD_URL, ctx, { policy: this.policy(ctx) });
    const entries = parseBoardEntries(body);
    if (entries.length === 0) {
      // A redesign, or a fetch that returned a shell. Either way this is not
      // "no bids today" — the board has carried 100+ postings continuously.
      throw new Error(
        `${this.key}: the bid board yielded ZERO rows — layout change or blocked fetch, not an empty board`,
      );
    }

    const cp = (ctx.checkpoint ?? {}) as Checkpoint;
    this.priorSeen = { ...(cp.seen ?? {}) };
    this.confirmed = {};

    // Re-fetch when the posting is new OR its closing date moved (an amendment
    // is the one change the board itself exposes).
    const stale = entries.filter((e) => this.priorSeen[e.slug] !== (e.closingIso ?? ""));
    const take = stale.slice(0, MAX_DETAIL_PER_RUN);

    ctx.logger.info(
      {
        listed: entries.length,
        newOrChanged: stale.length,
        fetching: take.length,
        deferredToNextRun: stale.length - take.length,
        crawlDelayMs: CRAWL_DELAY_MS,
      },
      stale.length > take.length
        ? "omwbe: per-run detail cap reached — remainder deferred, not dropped"
        : "omwbe: discovery complete",
    );

    return take.map((e) => ({
      idempotencyKey: `${this.key}:${e.slug}`,
      canonicalUrl: e.url,
      parentUrl: BOARD_URL,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta: { slug: e.slug, listingTitle: e.title, closingIso: e.closingIso },
    }));
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    return httpFetchArtifact(item, ctx, { policy: this.policy(ctx) });
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedRecord[]> {
    const meta = (raw.discovered.meta ?? {}) as {
      slug?: string;
      listingTitle?: string;
      closingIso?: string | null;
    };
    const slug = meta.slug ?? raw.discovered.canonicalUrl.split("/bid-opportunities/")[1] ?? "";
    if (!slug) return [];

    const $ = loadHtml(raw.body);
    // Drupal namespaces custom fields, so the class is `field-name-field-*`
    // while the built-in body is plain `field-name-body`.
    const organization = fieldValue($, "field-your-organization");
    const contact = fieldValue($, "field-your-email-address");
    const closingText = fieldValue($, "field-closing-date");
    const bodyText = fieldValue($, "body");

    // Title: the listing's is the canonical one (the detail H1 is the site
    // banner on this Drupal theme, not the posting title).
    const title = meta.listingTitle?.trim() || slug.replaceAll("-", " ");

    // The board's RDFa datetime is authoritative and already ISO. The detail
    // page's "Thursday, August 6, 2026" is a human rendering of the same field,
    // used only when the listing had none.
    const bidDueAt = meta.closingIso ?? parseLongDate(closingText);

    const isSubBid = SUB_BID_TITLE.test(title);
    // On a sub-bid post the organization IS the prime; on an agency posting it
    // is the procuring agency. The site uses one field for both, so the title
    // classification is what disambiguates them. Never both.
    const primeContractor = isSubBid ? organization : null;
    // Null when the submitter left the field blank — these are third-party
    // postings and a placeholder string would read as a real agency name.
    const procuringAgency = isSubBid ? null : organization;

    const evidence = [
      {
        factPath: "title",
        text: title,
        pageOrSection: "OMWBE bid board listing",
      },
    ];
    if (closingText) {
      evidence.push({
        factPath: "bidDueAt",
        text: closingText,
        pageOrSection: "detail page closing date",
      });
    }
    if (organization) {
      evidence.push({
        factPath: isSubBid ? "primeContractor" : "procuringAgency",
        text: `Organization: ${organization}`,
        pageOrSection: "detail page organization field",
      });
    }

    const record: NormalizedSolicitationRecord = {
      sourceKey: this.key,
      externalId: slug,
      // OMWBE has no solicitation-number field; the number is embedded in the
      // title in whatever form the submitter chose. Extracted when it is
      // unambiguous, null otherwise — never invented.
      solicitationNumber: solicitationNumberFrom(title),
      title,
      description: bodyText ? bodyText.slice(0, 4000) : null,
      procuringAgency,
      primeContractor,
      documentType: isSubBid ? "sub_bid_request" : "solicitation",
      bidDueAt,
      issuedAt: null,
      // The board lists open postings; a closed one drops off. `amended`/
      // `awarded` are not observable here, so claiming them would be a guess.
      status: "open",
      // Statewide board — most postings state no county, and several are
      // out-of-state reposts. Null is the correct answer, which is the entire
      // reason this record class exists.
      county: null,
      city: null,
      scopeRaw: bodyText,
      // Trade matching is a downstream concern (deriveProjectTrades owns the
      // shared vocabulary); emitting guesses here would compete with it.
      tradeTags: [],
      organizations: organization
        ? [
            {
              name: organization,
              role: isSubBid ? "prime" : "procuring_agency",
              evidenceText: `Organization: ${organization}${contact ? ` (${contact})` : ""}`,
            },
          ]
        : [],
      sourceUrl: raw.discovered.canonicalUrl,
      evidence,
    };

    // Only mark the slug done once it has actually parsed, so a posting that
    // failed to fetch is retried rather than skipped forever.
    this.confirmed[slug] = meta.closingIso ?? "";
    ctx.setCheckpoint({ seen: { ...this.priorSeen, ...this.confirmed } });

    const parsed: ParsedSolicitationRecord = {
      kind: "solicitation",
      rawFields: {
        slug,
        listingTitle: meta.listingTitle ?? null,
        closingIso: meta.closingIso ?? null,
        closingText,
        organization,
        contact,
        bodyChars: bodyText?.length ?? 0,
      },
      record,
    };
    return [parsed];
  }

  /**
   * D1 — the two ways this source can silently lie.
   *
   * A Drupal theme change turns every field lookup into null while the fetch
   * still returns 200, so an all-null parse is the failure mode to catch. And a
   * closing date that stopped being a date means the RDFa attribute moved.
   */
  checkInvariants(_raw: RawArtifact, parsed: ParsedRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    for (const p of parsed) {
      const rf = p.rawFields as {
        slug?: string;
        closingIso?: string | null;
        organization?: string | null;
        bodyChars?: number;
      };
      if (rf.closingIso && Number.isNaN(Date.parse(rf.closingIso))) {
        out.push({
          check: "omwbe_closing_date_not_a_date",
          detail: `${rf.slug}: closingIso="${rf.closingIso}" does not parse — the RDFa date attribute moved`,
          observed: rf.closingIso,
          expected: "ISO datetime",
        });
      }
      if (!rf.organization && !rf.bodyChars) {
        out.push({
          check: "omwbe_detail_fields_empty",
          detail: `${rf.slug}: neither the organization field nor the body parsed — likely a template change, not an empty posting`,
          observed: "no fields",
          expected: "at least one of field-your-organization / field-body",
        });
      }
    }
    return out;
  }
}

/**
 * "Thursday, August 6, 2026" → ISO. Only this exact shape; anything else is
 * null rather than a best guess at a deadline.
 */
export function parseLongDate(text: string | null): string | null {
  if (!text) return null;
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!m) return null;
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${m[3]} 00:00:00 GMT-0700`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Pull a solicitation number out of a submitter-written title, but only from
 * the unambiguous forms: an explicit "#1234-56", or a labelled prefix
 * ("ITB 26-011-LPW", "RFP No. 26-03"). Everything else is null.
 */
export function solicitationNumberFrom(title: string): string | null {
  const hash = /#\s*([A-Z0-9][A-Z0-9._/-]{2,})/i.exec(title);
  if (hash?.[1]) return hash[1].replace(/[.,;:]$/, "");
  const labelled =
    /\b(?:ITB|RFP|RFQ|RFQQ|RFI|RFB|IFB|SOQ)\s*(?:No\.?|#)?\s*([0-9][A-Z0-9._/-]{2,})/i.exec(title);
  return labelled?.[1] ? labelled[1].replace(/[.,;:]$/, "") : null;
}

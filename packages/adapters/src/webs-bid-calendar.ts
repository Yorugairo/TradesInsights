import { loadHtml } from "@otn/documents";
import {
  httpRequest,
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
 * WEBS public bid calendar — statewide WA agency solicitations.
 *
 * TRANSPORT, and the thing that actually blocks a naive implementation.
 *
 * This is a classic ASP.NET DataGrid: 6 pages of 25 rows, paged by
 * `__doPostBack('DataGrid1$_ctl29$_ctlN','')` with no GET parameters. Every
 * postback must carry `__VIEWSTATE`, `__VIEWSTATEGENERATOR` and
 * `__EVENTVALIDATION` re-read from the PREVIOUS response.
 *
 * That much was expected. What was not: **the ViewState alone is not enough.**
 * Measured 2026-07-27 — a postback with a perfectly valid ViewState and NO
 * `ASP.NET_SessionId` cookie returns HTTP 200 with a full, well-formed grid
 * that is PAGE ONE AGAIN. Identical 25 detail ids, zero overlap difference. It
 * does not error, it does not redirect, it silently re-serves the first page.
 * A scraper written without cookies would have looked perfect and collected
 * page 1 six times, then reported 150 records of which 125 were duplicates.
 * Carrying the cookie jar, the same requests return pages with ZERO overlap.
 *
 * That is why the session cookie is threaded through explicitly and why
 * `checkInvariants` asserts pages do not repeat: this failure mode is invisible
 * to row counts, to HTTP status, and to schema validation.
 *
 * SCOPE. Only the public calendar. `Search_BidDetails.aspx?ID=<n>` returns the
 * vendor LOGIN page, so per-solicitation detail — including the procuring
 * agency — is out of reach and `procuringAgency` is null for every WEBS record.
 * That is recorded truthfully rather than filled with a placeholder.
 */

const CALENDAR_URL = "https://pr-webs-vendor.des.wa.gov/BidCalendar.aspx";

/**
 * Hard ceiling on the page walk. The calendar has shown 6 pages; 15 leaves room
 * to grow while making a pager-parsing bug terminate instead of looping.
 */
const MAX_PAGES = 15;

/**
 * A page that parses to fewer rows than this is treated as a failure, not as a
 * quiet day. An expired ViewState renders an error page that parses to ZERO
 * rows, which is indistinguishable from "no solicitations" unless asserted
 * against — the same class of defect as an orphaned run reading green.
 */
const MIN_ROWS_PAGE_ONE = 5;

export interface WebsRow {
  /** `Search_BidDetails.aspx?ID=57169` → "57169". Stable across amendments. */
  detailId: string;
  closeDate: string | null;
  title: string;
  referenceNumber: string | null;
  contact: string | null;
  amendmentDate: string | null;
  description: string | null;
  preBidConference: string | null;
  questionsDeadline: string | null;
  inclusionPlan: string | null;
}

/** `MM/DD/YY` (optionally with `HH:MM`) → ISO, Pacific. */
export function usShortDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(text.trim());
  if (!m) return null;
  // Two-digit years on a live bid calendar are this century; a bid closing in
  // 1926 is not a case worth modelling.
  const year = 2000 + Number(m[3]);
  const hh = m[4] ?? "00";
  const mm = m[5] ?? "00";
  const iso = `${year}-${m[1]}-${m[2]}T${hh}:${mm}:00`;
  const parsed = Date.parse(`${iso}-07:00`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Parse one calendar page's grid. Exported for the fixture test. */
export function parseCalendarPage(html: string | Buffer): WebsRow[] {
  const $ = loadHtml(html);
  const out: WebsRow[] = [];
  for (const tr of $("#DataGrid1 > tbody > tr, #DataGrid1 > tr").toArray()) {
    const link = $(tr).find("a[href*='Search_BidDetails.aspx?ID=']").first();
    const href = link.attr("href");
    if (!href) continue; // header row and the numeric pager row
    const detailId = href.split("ID=")[1]?.split("&")[0];
    if (!detailId) continue;

    const txt = (sel: string): string | null => {
      const el = $(tr).find(sel).first();
      if (el.length === 0) return null;
      const t = el.text().replace(/\s+/g, " ").trim();
      return t.length > 0 ? t : null;
    };

    // Addressed by the ASP.NET control-id SUFFIX rather than by cell position.
    // The row is a nested 5-row table whose cells shift whenever an optional
    // field (pre-bid conference, Q&A deadline) is absent, so positional
    // indexing silently mis-assigns fields on exactly the rows that differ.
    const title = link.text().replace(/\s+/g, " ").trim();
    const refSpan = $(tr).find("span.text-small").first().text().replace(/\s+/g, " ");
    const refMatch = /Ref #:\s*(\S+)/.exec(refSpan);

    out.push({
      detailId,
      closeDate: txt("span[id$='_Label1']"),
      title,
      referenceNumber: refMatch?.[1] ?? null,
      contact: txt("span[id$='_Label4']"),
      amendmentDate: txt("span[id$='_lblAmendmentDate']"),
      description: txt("td.text-small"),
      preBidConference: txt("span[id$='_PreBidConferenceLabel']"),
      questionsDeadline: txt("span[id$='_QAPeriodLabel']"),
      inclusionPlan: txt("span[id$='_InclusionPlanLabel']"),
    });
  }
  return out;
}

/** The `__doPostBack` targets of the numeric pager, in page order. */
export function pagerTargets(html: string | Buffer): string[] {
  const $ = loadHtml(html);
  const targets: string[] = [];
  for (const a of $("#DataGrid1 a[href*='__doPostBack']").toArray()) {
    const href = $(a).attr("href") ?? "";
    const m = /__doPostBack\('([^']+)'/.exec(href);
    const target = m?.[1];
    // Only the pager. Every data row also carries an "Additional Data"
    // postback link, and following those would page nowhere.
    if (target && !target.includes("AdditionalDataLinkButton") && !targets.includes(target)) {
      targets.push(target);
    }
  }
  return targets;
}

function hiddenFields(html: string): Record<string, string> {
  const $ = loadHtml(html);
  const get = (n: string) => $(`input[name='${n}']`).attr("value") ?? "";
  return {
    __VIEWSTATE: get("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: get("__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: get("__EVENTVALIDATION"),
  };
}

export class WebsBidCalendarAdapter implements SourceAdapter {
  readonly key = "webs_bid_calendar";
  readonly parserVersion = "1.0.0";

  /**
   * The page walk is inherently stateful and sequential — page N+1 needs page
   * N's ViewState — so it happens once in `discover` and the bytes are handed
   * to `fetch`. The runner still stores each page as its own immutable
   * artifact, so replay and dedupe are unaffected.
   */
  private pages = new Map<number, string>();

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    // One request at a time: this is a session-bound form walk, and parallel
    // postbacks against one ASP.NET session interleave ViewStates.
    const policy = policyForRun(ctx, { maxConcurrency: 1 });
    this.pages.clear();

    const first = await httpRequest(CALENDAR_URL, ctx, { policy });
    const firstHtml = first.body.toString();
    const rows = parseCalendarPage(firstHtml);
    if (rows.length < MIN_ROWS_PAGE_ONE) {
      throw new Error(
        `${this.key}: page 1 parsed ${rows.length} rows (< ${MIN_ROWS_PAGE_ONE}) — an expired ViewState or an error page renders as an EMPTY GRID, which is not the same as "no solicitations today"`,
      );
    }
    this.pages.set(1, firstHtml);

    // Keep the whole cookie jar, not just ASP.NET_SessionId — the site also
    // sets a `TS...` edge cookie, and dropping it is the sort of partial
    // session that fails intermittently rather than outright.
    const cookie = first.setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) {
      ctx.logger.warn(
        { url: CALENDAR_URL },
        "webs: no session cookie returned — paging will silently re-serve page 1",
      );
    }

    const targets = pagerTargets(firstHtml).slice(0, MAX_PAGES - 1);
    let prevHtml = firstHtml;
    let page = 1;

    for (const target of targets) {
      page += 1;
      const fields = hiddenFields(prevHtml);
      const body = new URLSearchParams({
        __EVENTTARGET: target,
        __EVENTARGUMENT: "",
        ...fields,
      }).toString();

      const res = await httpRequest(CALENDAR_URL, ctx, {
        policy,
        request: {
          method: "POST",
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: CALENDAR_URL,
            ...(cookie ? { cookie } : {}),
          },
        },
      });
      const html = res.body.toString();
      if (parseCalendarPage(html).length === 0) {
        // Stop rather than throw: pages 1..N-1 are real records and dropping
        // them because page N broke would be worse than a short run.
        ctx.logger.warn({ page, target }, "webs: page parsed zero rows — stopping the walk");
        break;
      }
      this.pages.set(page, html);
      prevHtml = html;
    }

    ctx.logger.info(
      { pages: this.pages.size, pagerTargets: targets.length, hadCookie: Boolean(cookie) },
      "webs: page walk complete",
    );

    return [...this.pages.keys()].map((p) => ({
      idempotencyKey: `${this.key}:page-${p}`,
      // Distinct per page so the artifact store does not collapse six pages
      // into one row. The fragment is not sent anywhere — paging is by POST.
      canonicalUrl: `${CALENDAR_URL}#page=${p}`,
      parentUrl: CALENDAR_URL,
      expectedContentType: "text/html",
      sourcePublishedAt: null,
      meta: { page: p },
    }));
  }

  async fetch(item: DiscoveredArtifact, _ctx: RunContext): Promise<RawArtifact> {
    const page = Number((item.meta as { page?: number } | undefined)?.page ?? 0);
    const html = this.pages.get(page);
    if (!html) throw new Error(`${this.key}: page ${page} was not captured during discovery`);
    return {
      discovered: item,
      body: Buffer.from(html),
      contentType: "text/html; charset=utf-8",
      httpStatus: 200,
      headers: {},
      retrievedAt: new Date(),
    };
  }

  async parse(raw: RawArtifact, _ctx: RunContext): Promise<ParsedRecord[]> {
    const page = Number((raw.discovered.meta as { page?: number } | undefined)?.page ?? 0);
    const out: ParsedRecord[] = [];

    for (const row of parseCalendarPage(raw.body)) {
      const bidDueAt = usShortDate(row.closeDate);
      const amendedAt = usShortDate(row.amendmentDate);

      const evidence = [
        {
          factPath: "title",
          text: `${row.title}${row.referenceNumber ? ` (Ref #: ${row.referenceNumber})` : ""}`,
          pageOrSection: `bid calendar page ${page}`,
        },
      ];
      if (row.closeDate) {
        evidence.push({
          factPath: "bidDueAt",
          text: `Solicitation Close Date ${row.closeDate}`,
          pageOrSection: `bid calendar page ${page}`,
        });
      }

      const record: NormalizedSolicitationRecord = {
        sourceKey: this.key,
        // The WEBS id, not the reference number: the reference is
        // agency-assigned and not guaranteed unique across agencies.
        externalId: row.detailId,
        solicitationNumber: row.referenceNumber,
        title: row.title,
        description: row.description,
        // Not published on the public calendar; only behind the vendor login.
        procuringAgency: null,
        primeContractor: null,
        // Every row here is an agency solicitation. Prime sub-bid calls are an
        // OMWBE phenomenon and are not posted to WEBS.
        documentType: "solicitation",
        bidDueAt,
        issuedAt: null,
        // An amendment date IS the calendar's own statement that the
        // solicitation changed after issue, so it is the one status transition
        // observable here. Everything else stays "open" rather than guessed.
        status: amendedAt ? "amended" : "open",
        // Statewide procurement: no county, no city, and no parcel. This is the
        // record that could never have been a permit.
        county: null,
        city: null,
        scopeRaw: row.description,
        tradeTags: [],
        organizations: row.contact
          ? [
              {
                name: row.contact,
                role: "contact",
                evidenceText: `Contact: ${row.contact}`,
              },
            ]
          : [],
        sourceUrl: `https://pr-webs-vendor.des.wa.gov/Search_BidDetails.aspx?ID=${row.detailId}`,
        evidence,
      };

      const parsed: ParsedSolicitationRecord = {
        kind: "solicitation",
        rawFields: {
          page,
          detailId: row.detailId,
          closeDate: row.closeDate,
          referenceNumber: row.referenceNumber,
          contact: row.contact,
          amendmentDate: row.amendmentDate,
          preBidConference: row.preBidConference,
          questionsDeadline: row.questionsDeadline,
          inclusionPlan: row.inclusionPlan,
        },
        record,
      };
      out.push(parsed);
    }

    return out;
  }

  /**
   * D1 — the three ways this source lies quietly.
   *
   * 1. An expired ViewState renders an error page that parses to zero rows.
   * 2. The close-date column stops holding a date (grid columns reordered).
   * 3. A page returns page 1's content again because the session was lost —
   *    the measured failure that has no other symptom.
   */
  checkInvariants(raw: RawArtifact, parsed: ParsedRecord[]): InvariantViolation[] {
    const out: InvariantViolation[] = [];
    const page = Number((raw.discovered.meta as { page?: number } | undefined)?.page ?? 0);

    if (parsed.length === 0) {
      out.push({
        check: "webs_empty_grid",
        detail: `page ${page} produced no records — an expired ViewState error page parses as zero rows`,
        observed: "0 rows",
        expected: `>= 1 row`,
      });
      return out;
    }

    for (const p of parsed) {
      const rf = p.rawFields as { detailId?: string; closeDate?: string | null };
      if (rf.closeDate && !/^\d{2}\/\d{2}\/\d{2}/.test(rf.closeDate)) {
        out.push({
          check: "webs_close_date_column_shift",
          detail: `${rf.detailId}: closeDate="${rf.closeDate}" is not MM/DD/YY — column drift`,
          observed: rf.closeDate,
          expected: "MM/DD/YY close date",
        });
      }
    }

    // Page-repeat detection. Only meaningful past page 1, and it is the reason
    // the whole cookie apparatus exists: a lost session serves page 1 forever
    // with a 200 and a full grid.
    if (page > 1) {
      const firstHtml = this.pages.get(1);
      if (firstHtml) {
        const firstIds = new Set(parseCalendarPage(firstHtml).map((r) => r.detailId));
        const theseIds = parsed.map((p) => (p.rawFields as { detailId?: string }).detailId);
        const repeated = theseIds.filter((id) => id && firstIds.has(id)).length;
        if (repeated === theseIds.length) {
          out.push({
            check: "webs_page_repeat",
            detail: `page ${page} returned page 1's rows verbatim — the ASP.NET session was lost, so paging silently re-served the first page`,
            observed: `${repeated}/${theseIds.length} ids identical to page 1`,
            expected: "a distinct set of solicitations",
          });
        }
      }
    }

    return out;
  }
}

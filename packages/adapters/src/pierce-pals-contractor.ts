import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  httpFetchArtifact,
  reconcileCount,
  type DiscoveredArtifact,
  type InvariantViolation,
  type ParsedSourceRecord,
  type RawArtifact,
  type RunContext,
  type SourceAdapter,
} from "@otn/source-sdk";
import type { NormalizedSourceRecord } from "@otn/domain";

const BASE = "https://pals.piercecountywa.gov";
const HEADER_API = `${BASE}/public/api/webApplPermitStatusHeader?applPermitId=`;

/**
 * Pierce PALS permit-header contact enrichment (Lookup-class, spec §5 hard
 * rule: enrich known records only, never the sole alert source).
 *
 * `pierce_permits_arcgis` gives every Pierce permit/application by
 * `applicationNumber` but leaves `organizations: []` — the county's open-data
 * layer carries no applicant/contractor contact. PALS Online's own
 * `webApplPermitStatusHeader?applPermitId=<id>` endpoint fills that gap: keyed
 * by the SAME id we already hold, it returns the applicant of record, their
 * phone, the permit's contractor licence, and the owner. This adapter turns one
 * header row into a normalized record whose ONLY new value is the enriched
 * `organizations[]` (applicant + owner, with phone/licence identifiers) — which
 * `resolver.ts` writes into `organization_identifiers` (migration 0023) so the
 * registry-observation rules can corroborate a permit's business phone against
 * the L&I registration phone. It resolves onto the existing Pierce development
 * by parcel; it does not originate opportunities.
 *
 * ACCESS REALITY (fixtures/pierce_pals_contractor/metadata.json): PALS is
 * gated by reCAPTCHA Enterprise v3. The token is minted by the app's own
 * `$http` interceptor when a genuine visitor loads a permit view; bare fetches
 * return 403/empty. Minting tokens ourselves would be a prohibited bot-control
 * bypass, so this source is CAPTURE-FED: the operator stages genuine-browser
 * captures (scripts/pals-header-capture.mjs drives the REAL SPA, which mints
 * its own tokens exactly as for any visitor) under
 * `$OTN_CAPTURE_DIR/pierce_pals_contractor/<applPermitId>.json`, and this
 * adapter treats each staged file as the fetched artifact — the same
 * operator-local pattern as tumwater_development_review. Live `fetch()` still
 * dead-letters by design when no capture is staged.
 *
 * SCALE AUTHORIZATION: owner approved scaling this lookup/hydration lane
 * 2026-07-24 (ToU accepted under owner authorization 2026-07-19; RCW
 * 42.56.070(8) scope reconciled — identity resolution of licensed BUSINESSES,
 * not commercial lists of individuals). Low-and-slow batches, operator-run,
 * in-region, enrich-known-records-only stays the hard rule.
 */

/** One PALS header row. Only the fields we read are typed; the rest pass
 * through so a new PALS field never fails the parse. */
const HeaderRowSchema = z
  .object({
    applPermitId: z.number(),
    applCustSysId: z.number().nullable().optional(),
    ownerCustSysId: z.number().nullable().optional(),
    applicantNm: z.string().nullable().optional(),
    applicantPhone: z.string().nullable().optional(),
    applicantPhoneAreaCd: z.string().nullable().optional(),
    applicantAddress1: z.string().nullable().optional(),
    applicantAddress2: z.string().nullable().optional(),
    applicantZip: z.string().nullable().optional(),
    contrLicNum: z.string().nullable().optional(),
    ownerNm: z.string().nullable().optional(),
    ownerPhone: z.string().nullable().optional(),
    ownerPhoneAreaCd: z.string().nullable().optional(),
    ownerAddress1: z.string().nullable().optional(),
    ownerAddress2: z.string().nullable().optional(),
    ownerZip: z.string().nullable().optional(),
    parcelNum: z.string().nullable().optional(),
    siteAddressSt: z.string().nullable().optional(),
    siteAddressCityStZip: z.string().nullable().optional(),
    communityTypeDesc: z.string().nullable().optional(),
    applStatusCd: z.string().nullable().optional(),
    applStatusDesc: z.string().nullable().optional(),
    applTypeCd: z.string().nullable().optional(),
    applTypeDesc: z.string().nullable().optional(),
    projName: z.string().nullable().optional(),
    projApplDesc: z.string().nullable().optional(),
    projApplDt: z.string().nullable().optional(),
    projApplIssuedDt: z.string().nullable().optional(),
    applPermitHref: z.string().nullable().optional(),
  })
  .passthrough();

type HeaderRow = z.infer<typeof HeaderRowSchema>;

/** PALS applStatusDesc → spec §9 stage. statusRaw always preserves the source
 * value; anything unmapped stays `unknown`, never guessed. */
function stageFor(desc: string | null | undefined): NormalizedSourceRecord["normalizedStage"] {
  const s = (desc ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.startsWith("cancel") || s === "denied" || s.startsWith("expired") || s.startsWith("withdraw"))
    return "withdrawn";
  if (s === "issued" || s.startsWith("issued")) return "permit_issued";
  if (s === "final") return "complete";
  if (s === "approved") return "approved";
  if (s === "accepted" || s === "pending payment") return "permit_applied";
  return "unknown";
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length ? t : null;
};

/** Applicant/owner phone from PALS' split area-code + local-number fields.
 * Returns a human-readable `AAA-NNN-NNNN` that `normalizePhoneUS` reduces to
 * bare 10 digits, or null when a full US number can't be formed (unknown is
 * null, never a partial). */
function formatPhone(
  areaCd: string | null | undefined,
  local: string | null | undefined,
): string | null {
  const area = (areaCd ?? "").replace(/\D/g, "");
  const rest = (local ?? "").replace(/\D/g, "");
  if (area.length !== 3 || rest.length !== 7) return null;
  return `${area}-${rest.slice(0, 3)}-${rest.slice(3)}`;
}

/** Contractor licence usable as a match key, or null. PALS partially masks
 * some licences (e.g. `DRHOR**963CS`); a masked value is NOT the licence, and
 * stripping the `*` would forge a wrong key — so masked and empty both return
 * null. The masked form is preserved in rawFields for the audit trail. */
function usableLicense(v: string | null | undefined): string | null {
  const t = clean(v);
  if (!t || t.includes("*")) return null;
  return t.length >= 4 ? t : null;
}

/** Join PALS' split mailing-address fields into one display string, or null.
 * `addr2` already carries "CITY, ST ZIP"; the zip field is appended only when
 * addr2 didn't include it. Nothing is invented — an empty street returns null
 * so we never emit a city-only fragment as a business address. */
function mailingAddress(
  addr1: string | null | undefined,
  addr2: string | null | undefined,
  zip: string | null | undefined,
): string | null {
  const street = clean(addr1);
  if (!street) return null;
  const cityLine = clean(addr2);
  const z = clean(zip);
  const parts = [street];
  if (cityLine) parts.push(cityLine);
  const joined = parts.join(", ");
  return z && !joined.includes(z) ? `${joined} ${z}` : joined;
}

/** PALS' internal customer id → a source-namespaced entity id, or null. Two
 * permits sharing this id are the same applicant/owner by the county's own
 * authority (see resolver same-source clustering). */
function palsEntityId(custSysId: number | null | undefined): string | null {
  return typeof custSysId === "number" && Number.isInteger(custSysId) && custSysId > 0
    ? `pierce_pals:${custSysId}`
    : null;
}

function isoDate(v: string | null | undefined): string | null {
  const t = clean(v);
  if (!t) return null;
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : new Date(d).toISOString().slice(0, 10);
}

function requestedId(item: DiscoveredArtifact): number | null {
  const fromMeta = item.meta?.["applPermitId"];
  if (typeof fromMeta === "number") return fromMeta;
  const m = /applPermitId=(\d+)/.exec(item.canonicalUrl);
  return m ? Number(m[1]) : null;
}

export class PiercePalsContractorAdapter implements SourceAdapter {
  readonly key = "pierce_pals_contractor";
  readonly parserVersion = "1.0.0";

  /**
   * Lookup-class discovery: the permit ids to enrich are seeded by the caller
   * into `ctx.checkpoint.permitIds` (the enrichment scheduler selects Pierce
   * records still missing contractor identifiers). With no seed there is
   * nothing to enrich — return [], never crawl the portal blindly.
   */
  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const seed = ctx.checkpoint?.["permitIds"];
    const idSet = new Set<number>(
      Array.isArray(seed)
        ? seed.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
        : [],
    );
    // Capture-fed scale path (owner-approved 2026-07-24): every staged
    // `$OTN_CAPTURE_DIR/pierce_pals_contractor/<applPermitId>.json` IS the work
    // list — the capture script's output alone drives a run, no checkpoint
    // seeding required. Non-numeric filenames are ignored, never guessed at.
    const captureDir = process.env["OTN_CAPTURE_DIR"];
    if (captureDir) {
      try {
        // Staged ids are appended AFTER checkpoint ids: the seed list's order is
        // the operator's priority (pals-hydrate-export emits recent-first), so
        // it must survive; staged files sort numerically for determinism.
        const staged: number[] = [];
        for (const f of await readdir(join(captureDir, this.key))) {
          const m = /^(\d+)\.json$/.exec(f);
          if (m) staged.push(Number(m[1]));
        }
        for (const id of staged.sort((a, b) => a - b)) idSet.add(id);
      } catch {
        // No staged directory — checkpoint-only discovery.
      }
    }
    const ids = [...idSet];
    if (ids.length === 0) {
      ctx.logger.info("pierce_pals_contractor: no permitIds seeded and no staged captures — nothing to enrich");
      return [];
    }
    return ids.map((id) => ({
      idempotencyKey: `${this.key}:${id}`,
      canonicalUrl: `${HEADER_API}${id}`,
      parentUrl: `${BASE}/palsonline/`,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
      meta: { applPermitId: id },
    }));
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    // Capture-fed: a staged genuine-browser capture is THE artifact (mirrors
    // tumwater_development_review). The golden-fixtures dir is deliberately not
    // consulted, so tests still exercise the dead-letter path.
    const captureDir = process.env["OTN_CAPTURE_DIR"];
    const staged = requestedId(item);
    if (captureDir && staged !== null) {
      try {
        const body = await readFile(join(captureDir, this.key, `${staged}.json`));
        if (body.byteLength > 0) {
          return {
            discovered: item,
            body,
            contentType: "application/json",
            httpStatus: 200,
            headers: { "content-type": "application/json" },
            retrievedAt: new Date(),
          };
        }
      } catch {
        // Capture dir set but this id has no staged file — fall through to the
        // live fetch, which dead-letters at the gate (visible, reproducible).
      }
    }
    const raw = await httpFetchArtifact(item, ctx);
    // Reproduce the reCAPTCHA gate as a dead-letter the run can show, rather
    // than passing an empty/HTML body to the parser as if it were data.
    if (raw.httpStatus === 403 || raw.body.byteLength === 0) {
      throw new Error(
        `pierce_pals_contractor: PALS returned ${raw.httpStatus ?? "empty"} for ${item.canonicalUrl} — ` +
          "reCAPTCHA Enterprise gate (no token). This source is genuine-visitor capture-fed; " +
          "auto-fetch cannot mint a token and must not bypass the control.",
      );
    }
    return raw;
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const text = raw.body.toString("utf8").trim();
    if (!text || raw.httpStatus === 403) {
      throw new Error("pierce_pals_contractor: empty/403 header body — reCAPTCHA gate, not data");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        "pierce_pals_contractor: header body is not JSON (likely a challenge/error page, not the API)",
      );
    }
    if (!Array.isArray(json)) {
      throw new Error("pierce_pals_contractor: expected a JSON array of one header row");
    }
    if (json.length === 0) return []; // permit id not found in PALS — no enrichment

    const out: ParsedSourceRecord[] = [];
    for (const entry of json) {
      const parsed = HeaderRowSchema.safeParse(entry);
      if (!parsed.success) {
        ctx.logger.warn({ entry }, "pierce_pals header row does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      out.push(this.rowToRecord(parsed.data));
    }
    return out;
  }

  private rowToRecord(row: HeaderRow): ParsedSourceRecord {
    const id = String(row.applPermitId);
    const applicantNm = clean(row.applicantNm);
    const ownerNm = clean(row.ownerNm);
    const applicantPhone = formatPhone(row.applicantPhoneAreaCd, row.applicantPhone);
    const ownerPhone = formatPhone(row.ownerPhoneAreaCd, row.ownerPhone);
    const applicantAddress = mailingAddress(row.applicantAddress1, row.applicantAddress2, row.applicantZip);
    const ownerAddress = mailingAddress(row.ownerAddress1, row.ownerAddress2, row.ownerZip);
    const applicantEntityId = palsEntityId(row.applCustSysId);
    const ownerEntityId = palsEntityId(row.ownerCustSysId);
    const license = usableLicense(row.contrLicNum);
    const licenseMasked = clean(row.contrLicNum) !== null && license === null;
    const parcel = clean(row.parcelNum);
    const site = clean(row.siteAddressSt);
    const statusRaw = clean(row.applStatusDesc);

    const organizations: NormalizedSourceRecord["organizations"] = [];
    if (applicantNm) {
      organizations.push({
        name: applicantNm,
        role: "applicant",
        evidenceText:
          `Applicant of record on PALS permit ${id}: ${applicantNm}` +
          (applicantPhone ? `, phone ${applicantPhone}` : "") +
          (license ? `, contractor licence ${license}` : "") +
          (applicantAddress ? `, address ${applicantAddress}` : ""),
        ...(applicantPhone ? { phone: applicantPhone } : {}),
        ...(license ? { contractorLicense: license } : {}),
        ...(applicantAddress ? { address: applicantAddress } : {}),
        ...(applicantEntityId ? { sourceEntityId: applicantEntityId } : {}),
      });
    }
    // Owner as a distinct org only when named and not byte-identical to the
    // applicant (self-pulled permits repeat the name; one org is enough). The
    // owner often has NO phone/licence — their mailing address + PALS customer
    // id are the only identifiers that can resolve them.
    if (ownerNm && ownerNm.toLowerCase() !== (applicantNm ?? "").toLowerCase()) {
      organizations.push({
        name: ownerNm,
        role: "owner",
        evidenceText:
          `Owner of record on PALS permit ${id}: ${ownerNm}` +
          (ownerPhone ? `, phone ${ownerPhone}` : "") +
          (ownerAddress ? `, address ${ownerAddress}` : ""),
        ...(ownerPhone ? { phone: ownerPhone } : {}),
        ...(ownerAddress ? { address: ownerAddress } : {}),
        ...(ownerEntityId ? { sourceEntityId: ownerEntityId } : {}),
      });
    }

    const sourceUrl = row.applPermitHref
      ? `${row.applPermitHref}${row.applPermitId}`
      : `${BASE}/palsonline/#/permitSearch/permit/departmentStatus?applPermitId=${id}`;

    const evidence: NormalizedSourceRecord["evidence"] = [
      {
        factPath: "title",
        text: `PALS permit ${id}: ${clean(row.projName) ?? clean(row.applTypeDesc) ?? "Pierce permit"}`,
        pageOrSection: "webApplPermitStatusHeader",
      },
    ];
    if (statusRaw)
      evidence.push({ factPath: "statusRaw", text: `applStatusDesc: ${statusRaw}`, pageOrSection: "webApplPermitStatusHeader" });
    if (applicantNm)
      evidence.push({
        factPath: "organizations[0]",
        text:
          `applicantNm: ${applicantNm}` +
          (applicantPhone ? ` | phone ${applicantPhone}` : "") +
          (license ? ` | contrLicNum ${license}` : licenseMasked ? ` | contrLicNum masked "${clean(row.contrLicNum)}"` : ""),
        pageOrSection: "webApplPermitStatusHeader",
      });
    if (parcel)
      evidence.push({ factPath: "parcelIds", text: `parcelNum: ${parcel}`, pageOrSection: "webApplPermitStatusHeader" });
    if (site)
      evidence.push({ factPath: "addressRaw", text: `siteAddressSt: ${site}`, pageOrSection: "webApplPermitStatusHeader" });

    const record: NormalizedSourceRecord = {
      sourceKey: this.key,
      externalId: id,
      recordType: "permit_contact_enrichment",
      title: `${id} – ${clean(row.projName) ?? clean(row.applTypeDesc) ?? "Pierce County permit"}`,
      description: clean(row.projApplDesc),
      permittingJurisdiction: "Pierce County",
      county: "Pierce",
      city: null,
      addressRaw: site,
      parcelIds: parcel ? [parcel] : [],
      geometry: null,
      applicationType: clean(row.applTypeDesc),
      permitType: clean(row.applTypeCd),
      documentType: null,
      statusRaw,
      normalizedStage: stageFor(row.applStatusDesc),
      applicationDate: isoDate(row.projApplDt),
      issueDate: isoDate(row.projApplIssuedDt),
      sourceUpdatedAt: null,
      valuationUsd: null,
      units: null,
      lots: null,
      squareFeet: null,
      organizations,
      sourceUrl,
      evidence,
    };

    return {
      record,
      rawFields: {
        ...row,
        contrLicNumMasked: licenseMasked ? clean(row.contrLicNum) : null,
        applicantPhoneFormatted: applicantPhone,
        ownerPhoneFormatted: ownerPhone,
        applicantAddressFormatted: applicantAddress,
        ownerAddressFormatted: ownerAddress,
        applicantEntityId,
        ownerEntityId,
      },
    };
  }

  /**
   * D1 self-reconciliation: the enriched row must be the permit we asked for,
   * no emitted phone may be a partial, and no emitted licence may carry a mask
   * character (a masked value must have been dropped, never forged into a key).
   */
  checkInvariants(raw: RawArtifact, parsed: ParsedSourceRecord[]): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const asked = requestedId(raw.discovered);
    const real = parsed.filter((p) => p.record.externalId);

    // One header artifact → at most one usable record.
    const countViolation = reconcileCount(
      "pierce_pals_row_count",
      asked === null ? null : Math.min(real.length, 1),
      real.length,
    );
    if (real.length > 1 && countViolation) violations.push(countViolation);

    for (const p of real) {
      if (asked !== null && p.record.externalId !== String(asked)) {
        violations.push({
          check: "pierce_pals_permit_id_mismatch",
          detail: `requested applPermitId ${asked} but header row is ${p.record.externalId}`,
          observed: p.record.externalId,
          expected: String(asked),
        });
      }
      for (const org of p.record.organizations) {
        if (org.phone && !/^\d{3}-\d{3}-\d{4}$/.test(org.phone)) {
          violations.push({
            check: "pierce_pals_phone_shape",
            detail: `${p.record.externalId}: phone "${org.phone}" is not a full US number`,
            observed: org.phone,
            expected: "AAA-NNN-NNNN",
          });
        }
        if (org.contractorLicense && org.contractorLicense.includes("*")) {
          violations.push({
            check: "pierce_pals_masked_license_leak",
            detail: `${p.record.externalId}: masked licence "${org.contractorLicense}" emitted as a key`,
            observed: org.contractorLicense,
            expected: "masked licences dropped",
          });
        }
      }
    }
    return violations;
  }
}

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { DiscoveredArtifact, RawArtifact } from "@otn/source-sdk";
import { PiercePalsContractorAdapter } from "./pierce-pals-contractor.js";
import { FIXTURES_DIR, testContext } from "./test-utils.js";

const DIR = join(FIXTURES_DIR, "pierce_pals_contractor");

interface GoldenEntry {
  file: string;
  applPermitId: number;
  applicantNm: string;
  phone: string;
  contrLicNum: string | null;
  ownerNm: string;
  parcelNum: string;
  siteAddressSt: string;
  applTypeDesc: string;
  applStatusDesc: string;
  note: string;
}

async function loadGolden(): Promise<GoldenEntry[]> {
  const meta = JSON.parse(await readFile(join(DIR, "metadata.json"), "utf8"));
  return meta.golden_set as GoldenEntry[];
}

function rawJson(body: unknown, applPermitId: number | null): RawArtifact {
  const discovered: DiscoveredArtifact = {
    idempotencyKey: `test:${applPermitId ?? "x"}`,
    canonicalUrl: `https://pals.piercecountywa.gov/public/api/webApplPermitStatusHeader?applPermitId=${applPermitId ?? ""}`,
    parentUrl: null,
    expectedContentType: "application/json",
    sourcePublishedAt: null,
    ...(applPermitId !== null ? { meta: { applPermitId } } : {}),
  };
  return {
    discovered,
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"),
    contentType: "application/json",
    httpStatus: 200,
    headers: {},
    retrievedAt: new Date("2026-07-19T00:00:00Z"),
  };
}

const STAGE_BY_STATUS: Record<string, string> = {
  Issued: "permit_issued",
  Final: "complete",
};

describe("pierce_pals_contractor — golden set matches the recorded manual comparison", () => {
  it("every golden permit parses to a schema-valid enrichment record", async () => {
    const adapter = new PiercePalsContractorAdapter();
    const golden = await loadGolden();
    expect(golden.length).toBeGreaterThanOrEqual(4);

    for (const g of golden) {
      const raw = rawJson(
        JSON.parse(await readFile(join(DIR, g.file), "utf8")),
        g.applPermitId,
      );
      const parsed = await adapter.parse(raw, testContext(adapter.key));
      expect(parsed.length, `${g.file}`).toBe(1);
      const { record, rawFields } = parsed[0]!;

      const v = NormalizedSourceRecordSchema.safeParse(record);
      expect(v.success, JSON.stringify(v.success ? null : v.error.issues)).toBe(true);

      // Identity + geography.
      expect(record.externalId).toBe(String(g.applPermitId));
      expect(record.recordType).toBe("permit_contact_enrichment");
      expect(record.county).toBe("Pierce");
      expect(record.permittingJurisdiction).toBe("Pierce County");
      expect(record.addressRaw).toBe(g.siteAddressSt);
      expect(record.parcelIds).toEqual([g.parcelNum]);
      expect(record.applicationType).toBe(g.applTypeDesc);
      expect(record.statusRaw).toBe(g.applStatusDesc);
      if (STAGE_BY_STATUS[g.applStatusDesc]) {
        expect(record.normalizedStage).toBe(STAGE_BY_STATUS[g.applStatusDesc]);
      }

      // Applicant org: name + phone always; licence ONLY when unmasked & present.
      const applicant = record.organizations.find((o) => o.role === "applicant")!;
      expect(applicant, `${g.file} applicant org`).toBeDefined();
      expect(applicant.name).toBe(g.applicantNm);
      expect(applicant.phone).toBe(g.phone);

      const licenceIsUsable = g.contrLicNum !== null && !g.contrLicNum.includes("*");
      if (licenceIsUsable) {
        expect(applicant.contractorLicense).toBe(g.contrLicNum);
      } else {
        expect(applicant.contractorLicense).toBeUndefined();
      }
      // Masked licences are never forged into a key, but ARE preserved for audit.
      const maskedExpected = g.contrLicNum && g.contrLicNum.includes("*") ? g.contrLicNum : null;
      expect(rawFields.contrLicNumMasked).toBe(maskedExpected);
      for (const o of record.organizations) {
        expect(o.contractorLicense ?? "").not.toContain("*");
      }

      // Owner org present when the owner name differs from the applicant.
      if (g.ownerNm.toLowerCase() !== g.applicantNm.toLowerCase()) {
        const owner = record.organizations.find((o) => o.role === "owner")!;
        expect(owner, `${g.file} owner org`).toBeDefined();
        expect(owner.name).toBe(g.ownerNm);
      }

      // Self-reconciliation is clean for a correct parse.
      expect(await adapter.checkInvariants(raw, parsed)).toEqual([]);
    }
  });

  it("Lennar (1067557): applicant IS the contractor — unmasked licence carried through", async () => {
    const adapter = new PiercePalsContractorAdapter();
    const raw = rawJson(JSON.parse(await readFile(join(DIR, "1067557.json"), "utf8")), 1067557);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const record = parsed[0]!.record;
    const applicant = record.organizations.find((o) => o.role === "applicant")!;
    expect(applicant.name).toBe("Lennar Northwest LLC.");
    expect(applicant.phone).toBe("253-882-8570");
    expect(applicant.contractorLicense).toBe("LENNANL783JO");
    // Promoted business identifiers (migration 0024): mailing address + PALS
    // customer id, so the same builder's permits cluster and can match L&I.
    expect(applicant.address).toBe("33820 WEYERHAEUSER WAY S UNIT, AUBURN, WA 98001");
    expect(applicant.sourceEntityId).toBe("pierce_pals:462942");
    expect(record.normalizedStage).toBe("permit_issued");

    // The owner (UPLANDS 320 LLC) has NO phone/licence — address + customer id
    // are the ONLY identifiers that can resolve them, and now they're emitted.
    const owner = record.organizations.find((o) => o.role === "owner")!;
    expect(owner.name).toBe("UPLANDS 320 LLC");
    expect(owner.phone).toBeUndefined();
    expect(owner.address).toBe("1302 PUYALLUP ST STE A, SUMNER, WA 98390");
    expect(owner.sourceEntityId).toBe("pierce_pals:454077");
  });

  it("Sunrise Church (1067513): owner-pulled, null licence, Final → complete", async () => {
    const adapter = new PiercePalsContractorAdapter();
    const raw = rawJson(JSON.parse(await readFile(join(DIR, "1067513.json"), "utf8")), 1067513);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const record = parsed[0]!.record;
    const applicant = record.organizations.find((o) => o.role === "applicant")!;
    expect(applicant.phone).toBe("253-848-8910");
    expect(applicant.contractorLicense).toBeUndefined(); // no contractor
    expect(record.normalizedStage).toBe("complete");
  });
});

describe("pierce_pals_contractor — discovery is Lookup-class (seed-driven)", () => {
  it("no seed → nothing to enrich", async () => {
    const adapter = new PiercePalsContractorAdapter();
    expect(await adapter.discover(testContext(adapter.key))).toEqual([]);
  });

  it("seeded permitIds → one header artifact each, deduped, keyed by id", async () => {
    const adapter = new PiercePalsContractorAdapter();
    const ctx = testContext(adapter.key, { checkpoint: { permitIds: [1067557, 1067557, 1067513] } });
    const arts = await adapter.discover(ctx);
    expect(arts.map((a) => a.idempotencyKey)).toEqual([
      "pierce_pals_contractor:1067557",
      "pierce_pals_contractor:1067513",
    ]);
    expect(arts[0]!.canonicalUrl).toContain("webApplPermitStatusHeader?applPermitId=1067557");
    expect(arts[0]!.meta?.applPermitId).toBe(1067557);
  });
});

describe("pierce_pals_contractor — failure & gate handling", () => {
  const adapter = new PiercePalsContractorAdapter();

  it("empty array (permit not found) → no records, no throw", async () => {
    expect(await adapter.parse(rawJson([], 999), testContext(adapter.key))).toEqual([]);
  });

  it("a reCAPTCHA challenge page (HTML, not JSON) throws rather than fabricating", async () => {
    await expect(
      adapter.parse(rawJson("<html>Access denied</html>", 1067557), testContext(adapter.key)),
    ).rejects.toThrow(/not JSON|challenge/i);
  });

  it("a non-array JSON body throws", async () => {
    await expect(
      adapter.parse(rawJson({ error: "nope" }, 1067557), testContext(adapter.key)),
    ).rejects.toThrow(/array/i);
  });

  it("a row missing applPermitId is rejected (sentinel), not emitted as a record", async () => {
    const parsed = await adapter.parse(rawJson([{ applicantNm: "X" }], 1), testContext(adapter.key));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.record.externalId).toBe(""); // rejected marker
  });

  it("checkInvariants flags a header row that isn't the permit we asked for", async () => {
    const raw = rawJson(JSON.parse(await readFile(join(DIR, "1067557.json"), "utf8")), 9_999_999);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    const violations = adapter.checkInvariants(raw, parsed);
    expect(violations.map((v) => v.check)).toContain("pierce_pals_permit_id_mismatch");
  });

  it("checkInvariants flags a masked licence forged into a key (regression guard)", async () => {
    const raw = rawJson(JSON.parse(await readFile(join(DIR, "1067557.json"), "utf8")), 1067557);
    const parsed = await adapter.parse(raw, testContext(adapter.key));
    // Simulate a regression where a mask leaked into the emitted key.
    parsed[0]!.record.organizations[0]!.contractorLicense = "DRHOR**963CS";
    const violations = adapter.checkInvariants(raw, parsed);
    expect(violations.map((v) => v.check)).toContain("pierce_pals_masked_license_leak");
  });
});

// Capture-fed scale path (owner-approved 2026-07-24): staged files under
// $OTN_CAPTURE_DIR/pierce_pals_contractor/ both DRIVE discovery and SERVE as
// the fetched artifact. Env is saved/restored so no other test inherits it.
describe("capture-fed discovery and fetch", () => {
  let savedCaptureDir: string | undefined;
  let dir: string;

  beforeEach(async () => {
    savedCaptureDir = process.env["OTN_CAPTURE_DIR"];
    dir = await mkdtemp(join(tmpdir(), "pals-capture-"));
    await mkdir(join(dir, "pierce_pals_contractor"), { recursive: true });
    process.env["OTN_CAPTURE_DIR"] = dir;
  });

  afterEach(async () => {
    if (savedCaptureDir === undefined) delete process.env["OTN_CAPTURE_DIR"];
    else process.env["OTN_CAPTURE_DIR"] = savedCaptureDir;
    await rm(dir, { recursive: true, force: true });
  });

  it("discovers every staged <applPermitId>.json and ignores non-numeric names", async () => {
    const sub = join(dir, "pierce_pals_contractor");
    await writeFile(join(sub, "1067513.json"), "[]");
    await writeFile(join(sub, "1067549.json"), "[]");
    await writeFile(join(sub, "notes.txt"), "not a capture");
    await writeFile(join(sub, "notanid.json"), "[]");
    const adapter = new PiercePalsContractorAdapter();
    const items = await adapter.discover(testContext("pierce_pals_contractor"));
    expect(items.map((i) => i.meta?.["applPermitId"])).toEqual([1067513, 1067549]);
  });

  it("unions staged captures with checkpoint-seeded permitIds, deduped", async () => {
    await writeFile(join(dir, "pierce_pals_contractor", "1067513.json"), "[]");
    const adapter = new PiercePalsContractorAdapter();
    const items = await adapter.discover(
      testContext("pierce_pals_contractor", { checkpoint: { permitIds: [1067513, 42] } }),
    );
    // Checkpoint order (the operator's priority) survives; the staged file
    // dedupes rather than reordering.
    expect(items.map((i) => i.meta?.["applPermitId"])).toEqual([1067513, 42]);
  });

  it("fetch serves the staged capture verbatim as a 200 artifact", async () => {
    const golden = await readFile(join(DIR, "1067513.json"));
    await writeFile(join(dir, "pierce_pals_contractor", "1067513.json"), golden);
    const adapter = new PiercePalsContractorAdapter();
    const item = (await adapter.discover(testContext("pierce_pals_contractor")))[0]!;
    const raw = await adapter.fetch(item, testContext("pierce_pals_contractor"));
    expect(raw.httpStatus).toBe(200);
    expect(raw.body.equals(golden)).toBe(true);
    // And the staged artifact parses end-to-end into the enrichment record.
    const parsed = await adapter.parse(raw, testContext("pierce_pals_contractor"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.record.externalId).toBe("1067513");
  });

  it("without OTN_CAPTURE_DIR, discovery still requires a checkpoint seed", async () => {
    delete process.env["OTN_CAPTURE_DIR"];
    const adapter = new PiercePalsContractorAdapter();
    expect(await adapter.discover(testContext("pierce_pals_contractor"))).toEqual([]);
  });
});

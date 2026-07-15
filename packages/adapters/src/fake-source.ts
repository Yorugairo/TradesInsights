import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  DiscoveredArtifact,
  ParsedSourceRecord,
  RawArtifact,
  RunContext,
  SourceAdapter,
} from "@otn/source-sdk";

const ManifestSchema = z.object({
  artifacts: z.array(
    z.object({
      file: z.string(),
      url: z.string().url(),
      publishedAt: z.string().nullable(),
    }),
  ),
});

const FixturePermitSchema = z.object({
  permit_number: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  address: z.string().nullable(),
  parcel: z.string().nullable(),
  permit_type: z.string().nullable(),
  status: z.string().nullable(),
  stage: z.string(),
  application_date: z.string().nullable(),
  issue_date: z.string().nullable(),
  valuation: z.number().nullable(),
  applicant: z.string().nullable(),
});

const FixtureFileSchema = z.object({
  jurisdiction: z.string(),
  county: z.string(),
  permits: z.array(z.unknown()),
});

/**
 * M0 harness adapter (spec M0.6 / M0 exit gate). Reads deterministic fixtures
 * from fixtures/fake_source/ — never the network — and exercises the full
 * discover → fetch → store → parse → persist pipeline.
 */
export class FakeSourceAdapter implements SourceAdapter {
  readonly key = "fake_source";
  readonly parserVersion = "1.0.0";

  private dir(ctx: RunContext): string {
    return join(ctx.fixturesDir, this.key);
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const manifestRaw = await readFile(join(this.dir(ctx), "manifest.json"), "utf8");
    const manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
    return manifest.artifacts.map((a) => ({
      idempotencyKey: `${this.key}:${a.file}`,
      canonicalUrl: a.url,
      parentUrl: "https://example.invalid/fake-source",
      expectedContentType: "application/json",
      sourcePublishedAt: a.publishedAt,
    }));
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    const file = item.idempotencyKey.split(":")[1];
    if (!file) throw new Error(`bad idempotency key: ${item.idempotencyKey}`);
    const body = await readFile(join(this.dir(ctx), file));
    return {
      discovered: item,
      body,
      contentType: "application/json",
      httpStatus: 200,
      headers: { "content-type": "application/json" },
      retrievedAt: new Date(),
    };
  }

  async parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const file = FixtureFileSchema.parse(JSON.parse(raw.body.toString("utf8")));
    const out: ParsedSourceRecord[] = [];
    for (const entry of file.permits) {
      const parsed = FixturePermitSchema.safeParse(entry);
      if (!parsed.success) {
        // Emit a deliberately-invalid record so the runner's Zod boundary
        // rejects it and counts it — malformed rows must never pass silently.
        ctx.logger.warn({ entry }, "fixture row does not match expected shape");
        out.push({
          record: { sourceKey: this.key, externalId: "", recordType: "" } as never,
          rawFields: (entry ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const p = parsed.data;
      out.push({
        rawFields: p,
        record: {
          sourceKey: this.key,
          externalId: p.permit_number,
          recordType: "building_permit",
          title: p.title,
          description: p.description,
          permittingJurisdiction: file.jurisdiction,
          county: file.county as never,
          city: null,
          addressRaw: p.address,
          parcelIds: p.parcel ? [p.parcel] : [],
          geometry: null,
          applicationType: null,
          permitType: p.permit_type,
          documentType: null,
          statusRaw: p.status,
          normalizedStage: p.stage as never,
          applicationDate: p.application_date,
          issueDate: p.issue_date,
          sourceUpdatedAt: null,
          valuationUsd: p.valuation,
          units: null,
          lots: null,
          squareFeet: null,
          organizations: p.applicant
            ? [
                {
                  name: p.applicant,
                  role: "applicant",
                  evidenceText: `Applicant: ${p.applicant}`,
                },
              ]
            : [],
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "title",
              text: p.title,
              pageOrSection: `permit ${p.permit_number}`,
            },
            ...(p.valuation !== null
              ? [
                  {
                    factPath: "valuationUsd",
                    text: `Valuation: $${p.valuation}`,
                    pageOrSection: `permit ${p.permit_number}`,
                  },
                ]
              : []),
          ],
        },
      });
    }
    return out;
  }
}

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

/**
 * M4.6 — customer-authorized bid-invitation ingestion (spec §6.4
 * `customer_bid_inbox`). Reads a customer-provided export (JSON files the
 * customer authorizes and drops into their inbox directory — never scraped,
 * never fetched with customer credentials). Everything ingested here is
 * PRIVATE to the owning account: the source row carries account_profile_id
 * and every read of the artifacts/evidence is access-audited (spec §20).
 *
 * "A permit is not a bid" has a positive dual here: this is the ONE source
 * class allowed to set `bidding_confirmed`, and only when the export line is
 * an explicit invitation/solicitation — anything else keeps its raw status
 * and stage stays unknown.
 */

const InvitationSchema = z.object({
  id: z.string().min(1),
  project_name: z.string().min(1),
  scope: z.string().nullable().default(null),
  general_contractor: z.string().nullable().default(null),
  estimator_contact: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  county: z.enum(["Thurston", "Pierce", "Lewis", "King"]).nullable().default(null),
  jurisdiction: z.string().nullable().default(null),
  /** The customer's platform status, verbatim. */
  invitation_status: z.string().min(1),
  received_at: z.string().nullable().default(null),
  bid_due_date: z.string().nullable().default(null),
});

const ExportFileSchema = z.object({
  account_key: z.string().min(1),
  exported_at: z.string(),
  platform: z.string().min(1),
  invitations: z.array(InvitationSchema),
});

const ManifestSchema = z.object({
  files: z.array(z.string().min(1)),
});

/** Statuses that are an explicit invitation to bid — nothing else confirms bidding. */
const EXPLICIT_INVITATION = /^(invited|invitation|itb|invitation_to_bid|rfp|rfq|solicitation)$/i;

export class CustomerBidInboxAdapter implements SourceAdapter {
  readonly parserVersion = "1.0.0";

  constructor(
    readonly key: string,
    /** The owning account — must match every export file's account_key. */
    private readonly accountKey: string,
  ) {}

  private dir(ctx: RunContext): string {
    // The inbox is a local, customer-provisioned directory — fixtures in
    // tests, CUSTOMER_BID_INBOX_DIR in production. A blank value counts as
    // UNSET (.env.example ships the key empty; "" must mean "not configured",
    // not "repo root"), so the documented fixtures fallback still applies.
    const configured = process.env.CUSTOMER_BID_INBOX_DIR?.trim();
    return join(configured || ctx.fixturesDir, this.key);
  }

  async discover(ctx: RunContext): Promise<DiscoveredArtifact[]> {
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(join(this.dir(ctx), "manifest.json"), "utf8")),
    );
    return manifest.files.map((file) => ({
      idempotencyKey: `${this.key}:${file}`,
      canonicalUrl: `private://${this.key}/${file}`,
      parentUrl: null,
      expectedContentType: "application/json",
      sourcePublishedAt: null,
      meta: { file },
    }));
  }

  async fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact> {
    const file = (item.meta as { file: string }).file;
    const body = await readFile(join(this.dir(ctx), file));
    return {
      discovered: item,
      body,
      contentType: "application/json",
      httpStatus: null,
      headers: {},
      retrievedAt: new Date(),
    };
  }

  async parse(raw: RawArtifact, _ctx: RunContext): Promise<ParsedSourceRecord[]> {
    const parsed = ExportFileSchema.parse(JSON.parse(raw.body.toString("utf8")));
    if (parsed.account_key !== this.accountKey) {
      // Wrong account's export in this inbox — refuse the whole file rather
      // than risk cross-account contamination.
      throw new Error(
        `export account_key ${parsed.account_key} does not match source account ${this.accountKey}`,
      );
    }

    return parsed.invitations.map((inv) => {
      const isExplicitInvitation = EXPLICIT_INVITATION.test(inv.invitation_status.trim());
      const organizations = inv.general_contractor
        ? [
            {
              name: inv.general_contractor,
              role: "primary_contractor",
              evidenceText: `General contractor: ${inv.general_contractor}`,
            },
          ]
        : [];
      return {
        // estimator_contact stays in rawFields only — contact data is
        // high-risk (M4.4) and never enters normalized/delivered fields.
        rawFields: { ...inv, platform: parsed.platform, exportedAt: parsed.exported_at },
        record: {
          sourceKey: this.key,
          externalId: inv.id,
          recordType: "bid_invitation",
          title: `${inv.project_name} – ${inv.invitation_status}`,
          description: inv.scope,
          permittingJurisdiction: inv.jurisdiction ?? "unknown",
          county: inv.county ?? "Thurston",
          city: null,
          addressRaw: inv.address,
          parcelIds: [],
          geometry: null,
          applicationType: null,
          permitType: null,
          documentType: "bid_invitation_export",
          statusRaw: inv.invitation_status,
          // The invariant, both directions: a permit is never a bid, and a
          // bid is confirmed ONLY by an explicit invitation/solicitation.
          normalizedStage: isExplicitInvitation ? "bidding_confirmed" : "unknown",
          applicationDate: null,
          issueDate: null,
          sourceUpdatedAt: inv.received_at,
          valuationUsd: null,
          units: null,
          lots: null,
          squareFeet: null,
          organizations,
          sourceUrl: raw.discovered.canonicalUrl,
          evidence: [
            {
              factPath: "externalId",
              text: `${inv.id} – ${inv.project_name} (${inv.invitation_status})`,
              pageOrSection: `${parsed.platform} export ${parsed.exported_at}`,
            },
            ...(isExplicitInvitation
              ? [
                  {
                    factPath: "statusRaw",
                    text: `Invitation status: ${inv.invitation_status}`,
                    pageOrSection: `${parsed.platform} export`,
                  },
                ]
              : []),
            ...(inv.bid_due_date
              ? [
                  {
                    factPath: "sourceUpdatedAt",
                    text: `Bid due: ${inv.bid_due_date}`,
                    pageOrSection: `${parsed.platform} export`,
                  },
                ]
              : []),
          ],
        },
      };
    });
  }
}

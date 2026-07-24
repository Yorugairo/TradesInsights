import { NextResponse } from "next/server";
import { z } from "zod";
import { recordRelationshipAcceptance } from "@otn/resolution";
import { jsonError, withAdmin } from "../../../../../lib/api.js";

/**
 * POST /api/admin/corporate-families/relationship — the accept action for the
 * corporate-family and principal↔person lanes. It records ONE already-accepted
 * `relationship_export` observation (entity↔entity, `principal_shared`) which the
 * nightly export pushes to registry_partner for the registry loader to adjudicate
 * into `registry_entity_relationships`. It NEVER binds identity; it teaches the
 * registry which companies share common control, closing the enrichment loop.
 *
 * One click per claim (no bulk path) — these carry private-individual evidence.
 */
const corroborationSchema = z.object({
  points: z.number(),
  verdict: z.enum(["strong", "corroborated", "name_only", "contradicted"]),
  signals: z.array(z.object({ key: z.string(), label: z.string(), agrees: z.boolean() })),
  explanation: z.string(),
});

const bodySchema = z.object({
  organizationId: z.string().min(1),
  registryEntityIdA: z.string().min(1),
  registryEntityIdB: z.string().min(1),
  principalKey: z.string().nullable().optional(),
  corroboration: corroborationSchema,
});

export const POST = withAdmin(async ({ db, session, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid relationship body");
  const { organizationId, registryEntityIdA, registryEntityIdB, principalKey, corroboration } = parsed.data;

  if (registryEntityIdA === registryEntityIdB) {
    return jsonError(400, "a relationship needs two distinct entities");
  }
  // Server-side guard: one click must never assert a relationship L&I's own
  // records contradict (e.g. a middle-initial conflict). The UI hides the button
  // for these; this is the defense-in-depth backstop.
  if (corroboration.verdict === "contradicted") {
    return jsonError(400, "cannot confirm a contradicted pair");
  }

  try {
    const result = await recordRelationshipAcceptance(db, {
      organizationId,
      entityIdA: registryEntityIdA,
      entityIdB: registryEntityIdB,
      principalKey: principalKey ?? null,
      corroboration,
      decidedBy: `web:${session.accountKey ?? "admin"}`,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(409, err instanceof Error ? err.message : "relationship record failed");
  }
});

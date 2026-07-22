import { z } from "zod";
import { CountySchema, ProjectStageSchema } from "./taxonomy.js";

// Minimal GeoJSON shapes accepted from parsers (spec §8).
export const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const GeoPolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).min(1),
});

export const GeometrySchema = z.union([GeoPointSchema, GeoPolygonSchema]);
export type Geometry = z.infer<typeof GeometrySchema>;

const IsoDateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date string");

/**
 * Spec §8 — every parser emits this shape. Unknown values are null,
 * never guessed and never coerced to zero.
 */
export const NormalizedSourceRecordSchema = z
  .object({
    sourceKey: z.string().min(1),
    externalId: z.string().min(1),
    recordType: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable(),
    permittingJurisdiction: z.string().min(1),
    county: CountySchema,
    city: z.string().nullable(),
    addressRaw: z.string().nullable(),
    parcelIds: z.array(z.string()),
    geometry: GeometrySchema.nullable(),
    applicationType: z.string().nullable(),
    permitType: z.string().nullable(),
    documentType: z.string().nullable(),
    statusRaw: z.string().nullable(),
    normalizedStage: ProjectStageSchema,
    applicationDate: IsoDateString.nullable(),
    issueDate: IsoDateString.nullable(),
    sourceUpdatedAt: IsoDateString.nullable(),
    valuationUsd: z.number().positive().nullable(),
    units: z.number().int().positive().nullable(),
    lots: z.number().int().positive().nullable(),
    squareFeet: z.number().positive().nullable(),
    organizations: z.array(
      z.object({
        name: z.string().min(1),
        role: z.string().nullable(),
        evidenceText: z.string().min(1),
        // Contractor identifiers, when the source publishes them (e.g. portal
        // detail pages, L&I-sourced feeds). Optional and additive: absent for
        // every source that doesn't emit them — never guessed (governing rule).
        phone: z.string().min(7).optional(),
        ubi: z.string().min(7).optional(),
        contractorLicense: z.string().min(4).optional(),
        // Postal (mailing/business) address exactly as the source published it —
        // a match key against the registry's L&I registered address, and the
        // ONLY identifier available for parties with no phone/licence (owners,
        // developers). Normalized at persist time; never fabricated.
        address: z.string().min(5).optional(),
        // A source-internal, source-namespaced entity id (e.g.
        // "pierce_pals:462942" from PALS' applCustSysId). Exact same-source
        // clustering key: two records sharing it are the same party by the
        // publisher's own authority, immune to name-string drift. Not a
        // cross-registry key — the adapter owns the namespace prefix.
        sourceEntityId: z.string().min(1).optional(),
        // Business website as published by the source, reduced at persist time
        // to a root-domain match key against the registry's registered website
        // (trades_identity_v1.root_domain). Additive and skip-safe: no adapter
        // emits it yet — the lane lights up as sources publish websites.
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

export type NormalizedSourceRecord = z.infer<
  typeof NormalizedSourceRecordSchema
>;

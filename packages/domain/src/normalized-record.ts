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

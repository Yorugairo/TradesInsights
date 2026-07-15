import { z } from "zod";
import { CountySchema } from "@otn/domain";

export const SourcePrioritySchema = z.enum(["P0", "P1", "lookup", "context", "test"]);

export const SourceAccessClassSchema = z.enum([
  "api_json",
  "arcgis",
  "socrata",
  "html",
  "pdf_index",
  "report_index",
  "dynamic_lookup",
  "authenticated",
  "landing_canary",
  "fixture",
]);

export const SourceCadenceSchema = z.enum([
  "daily",
  "weekly",
  "monthly",
  "on_demand",
]);

export const SourceConfigSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().min(1),
    authority: z.string().min(1),
    priority: SourcePrioritySchema,
    landing_url: z.string().url(),
    access_url: z.string().url().nullable().default(null),
    format: z.string().min(1),
    access_class: SourceAccessClassSchema,
    cadence: SourceCadenceSchema,
    county: CountySchema.nullable().default(null),
    permitting_jurisdiction: z.string().nullable().default(null),
    // Verify-before-enable (CLAUDE.md invariant): a source ships disabled and
    // is enabled only after the §5 activation checklist passes.
    enabled: z.boolean().default(false),
    terms_reviewed_at: z.string().nullable().default(null),
    robots_reviewed_at: z.string().nullable().default(null),
    notes: z.string().nullable().default(null),
  })
  .strict();

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const SourcesFileSchema = z
  .object({ sources: z.array(SourceConfigSchema) })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const s of file.sources) {
      if (seen.has(s.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate source key: ${s.key}`,
        });
      }
      seen.add(s.key);
      if (s.enabled && (!s.terms_reviewed_at || !s.robots_reviewed_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `source ${s.key} is enabled but terms/robots review dates are missing`,
        });
      }
    }
  });

export type SourcesFile = z.infer<typeof SourcesFileSchema>;

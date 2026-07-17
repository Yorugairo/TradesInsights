import { z } from "zod";

const ScoreComponentSchema = z.object({
  component: z.string().min(1),
  weight: z.number().int().min(0).max(100),
});

export const AccountRuleSchema = z
  .object({
    rule_type: z.enum(["routing", "scoring", "territory", "exclusion", "capacity"]),
    version: z.number().int().min(1),
    effective_at: z.string(),
    provisional: z.boolean().default(false),
    rule: z.record(z.unknown()),
  })
  .strict();

export const AccountProfileSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]+$/),
    name: z.string().min(1),
    active: z.boolean().default(true),
    organization: z
      .object({
        legal_name: z.string().min(1),
        ubi: z.string().nullable().default(null),
        contractor_registration: z.string().nullable().default(null),
        excluded_ubis: z.array(z.string()).default([]),
        website: z.string().url().nullable().default(null),
      })
      .strict(),
    capabilities: z.array(z.string().min(1)),
    territory: z
      .object({
        counties_included: z.array(z.string()),
        counties_excluded: z.array(z.string()).default([]),
        notes: z.string().nullable().default(null),
      })
      .strict(),
    score_components: z.array(ScoreComponentSchema),
    delivery: z
      .object({
        priority_review_min: z.number().int().default(80),
        weekly_digest_min: z.number().int().default(65),
        /** P2.1 — the "easy win" digest cut (all fields provisional until the
         * account's calibration session; absent home/radius disables the
         * geo check honestly rather than guessing). */
        easy_win: z
          .object({
            home_lon: z.number().nullable().default(null),
            home_lat: z.number().nullable().default(null),
            radius_km: z.number().positive().default(60),
            max_age_days: z.number().int().positive().default(60),
            min_valuation_usd: z.number().nullable().default(null),
            max_valuation_usd: z.number().nullable().default(null),
          })
          .strict()
          .optional(),
      })
      .strict(),
    rules: z.array(AccountRuleSchema).default([]),
    calibration_pending: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const total = p.score_components.reduce((sum, c) => sum + c.weight, 0);
    if (p.score_components.length > 0 && total !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `score component weights for ${p.key} must total 100, got ${total}`,
      });
    }
  });

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfilesFileSchema = z
  .object({ accounts: z.array(AccountProfileSchema) })
  .strict();

export type AccountProfilesFile = z.infer<typeof AccountProfilesFileSchema>;

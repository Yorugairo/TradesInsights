import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Db } from "@otn/db";
import type { DigestModel } from "./digest.js";
import { digestSubject, renderDigestHtml } from "./render.js";

/**
 * Idempotent digest delivery (spec §18): one delivery row per
 * (account, week), keyed by a deterministic idempotency key. Re-running never
 * duplicates a delivery or re-sends a sent one; the stored rendered content
 * is what was (or will be) sent, never regenerated after sending.
 */

export interface DeliverResult {
  deliveryId: string;
  status: string;
  created: boolean;
  sent: boolean;
  recipient: string;
  idempotencyKey: string;
}

export function weeklyIdempotencyKey(accountKey: string, periodEnd: Date): string {
  return `weekly:${accountKey}:${periodEnd.toISOString().slice(0, 10)}`;
}

function allItems(model: DigestModel) {
  return [
    ...model.sections.priorityNew,
    ...model.sections.stageChanges,
    ...model.sections.missingFacts,
    ...model.sections.monitoring,
  ];
}

export interface DeliverOptions {
  send?: boolean;
  /** Overrides the default pilot recipient (delivery config / placeholder). */
  recipient?: string;
  smtp?: { host: string; port: number };
  from?: string;
}

export async function deliverDigest(
  db: Db,
  model: DigestModel,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  const idempotencyKey = weeklyIdempotencyKey(model.accountKey, model.periodEnd);
  const recipient = opts.recipient ?? `${model.accountKey}@pilot.otn.local`;

  const existing = await db.execute(sql`
    SELECT id, status FROM deliveries WHERE idempotency_key = ${idempotencyKey}`);
  let deliveryId: string;
  let status: string;
  let created = false;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as { id: string; status: string };
    deliveryId = row.id;
    status = row.status;
    if (status === "sent") {
      // Already delivered — idempotent no-op, even with send requested.
      return { deliveryId, status, created: false, sent: false, recipient, idempotencyKey };
    }
  } else {
    const items = allItems(model);
    const rendered = renderDigestHtml(model);
    const metadata = {
      recipient,
      ruleVersions: model.ruleVersions,
      suppressed: model.suppressed,
      candidateCount: model.candidateCount,
      opportunityIds: items.map((i) => i.opportunityId),
      eventIds: items.flatMap((i) => i.eventIds),
      coverage: model.sections.coverage,
    };
    const inserted = await db.execute(sql`
      INSERT INTO deliveries
        (account_profile_id, delivery_type, period_start, period_end,
         rendered_content, status, idempotency_key, metadata_json)
      VALUES
        (${model.accountProfileId}, 'weekly_digest', ${model.periodStart.toISOString()},
         ${model.periodEnd.toISOString()}, ${rendered}, 'draft', ${idempotencyKey},
         ${JSON.stringify(metadata)})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`);
    if (inserted.rows.length === 0) {
      // Lost a race to a concurrent run — fall back to the existing row.
      const again = await db.execute(sql`
        SELECT id, status FROM deliveries WHERE idempotency_key = ${idempotencyKey}`);
      const row = again.rows[0] as { id: string; status: string };
      deliveryId = row.id;
      status = row.status;
    } else {
      deliveryId = (inserted.rows[0] as { id: string }).id;
      status = "draft";
      created = true;
      let position = 0;
      for (const item of items) {
        await db.execute(sql`
          INSERT INTO delivery_items (delivery_id, opportunity_id, project_event_id, position)
          VALUES (${deliveryId}, ${item.opportunityId}, ${item.eventIds[0] ?? null}, ${position++})`);
      }
    }
  }

  let sent = false;
  if (opts.send && status !== "sent") {
    const row = await db.execute(
      sql`SELECT rendered_content FROM deliveries WHERE id = ${deliveryId}`,
    );
    const rendered = (row.rows[0] as { rendered_content: string }).rendered_content;
    const transport = nodemailer.createTransport({
      host: opts.smtp?.host ?? process.env.SMTP_HOST ?? "localhost",
      port: opts.smtp?.port ?? Number(process.env.SMTP_PORT ?? 1025),
      secure: false,
    });
    await transport.sendMail({
      from: opts.from ?? process.env.EMAIL_FROM ?? "insights@otn.local",
      to: recipient,
      subject: digestSubject(model),
      html: rendered,
    });
    await db.execute(sql`
      UPDATE deliveries SET status = 'sent', sent_at = now() WHERE id = ${deliveryId}`);
    status = "sent";
    sent = true;
  }

  return { deliveryId, status, created, sent, recipient, idempotencyKey };
}

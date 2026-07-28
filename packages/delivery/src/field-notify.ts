import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import type { Db } from "@otn/db";

/**
 * Owner notification for a field-submitted change order — a claimed extra is
 * money and must not wait for the next cockpit visit.
 *
 * Same idempotent deliveries discipline as the digest (deliver.ts), minus the
 * rendering pipeline: one row per entry keyed `field-co:{entryId}`, so a crew
 * member double-submitting (or a retried request) can never double-email.
 * Same env-gated transport (SMTP_HOST/SMTP_PORT, dev default localhost:1025).
 *
 * MUST NOT THROW into the crew's request path: the entry standing is the
 * product; the email is a courtesy. Callers fire-and-forget and this function
 * swallows transport failures after recording the attempt.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface FieldNotifyInput {
  accountProfileId: string;
  accountKey: string;
  entryId: string;
  pursuitId: string;
  projectName: string;
  body: string;
  amount: number | null;
  submittedName: string | null;
  baseUrl: string;
}

export async function sendFieldChangeOrderNotification(
  db: Db,
  input: FieldNotifyInput,
  opts: { recipient?: string; smtp?: { host: string; port: number }; from?: string; send?: boolean } = {},
): Promise<{ deliveryId: string | null; sent: boolean }> {
  const idempotencyKey = `field-co:${input.entryId}`;
  const recipient = opts.recipient ?? `${input.accountKey}@pilot.otn.local`;
  const amountLine =
    input.amount !== null ? `<p>Claimed amount: <strong>~$${input.amount.toLocaleString("en-US")}</strong> (estimate until approved)</p>` : "";
  const html = `<p>A change order was submitted from the field on <strong>${esc(input.projectName)}</strong>${
    input.submittedName ? ` by ${esc(input.submittedName)}` : ""
  }.</p>
<blockquote>${esc(input.body)}</blockquote>
${amountLine}
<p><a href="${esc(input.baseUrl)}/app/pursuits/${esc(input.pursuitId)}">Review and approve in OTN Insights</a></p>`;

  const inserted = await db.execute(sql`
    INSERT INTO deliveries
      (account_profile_id, delivery_type, period_start, period_end, rendered_content, status, idempotency_key, metadata_json)
    VALUES
      (${input.accountProfileId}, 'field_notify', now(), now(), ${html}, 'draft', ${idempotencyKey},
       ${JSON.stringify({ entryId: input.entryId, pursuitId: input.pursuitId })})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`);
  if (inserted.rows.length === 0) return { deliveryId: null, sent: false }; // already notified
  const deliveryId = (inserted.rows[0] as { id: string }).id;

  if (opts.send === false) return { deliveryId, sent: false };
  try {
    const transport = nodemailer.createTransport({
      host: opts.smtp?.host ?? process.env.SMTP_HOST ?? "localhost",
      port: opts.smtp?.port ?? Number(process.env.SMTP_PORT ?? 1025),
      secure: false,
    });
    await transport.sendMail({
      from: opts.from ?? process.env.EMAIL_FROM ?? "insights@otn.local",
      to: recipient,
      subject: `[OTN] Change order from the field — ${input.projectName}`,
      html,
    });
    await db.execute(sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE id = ${deliveryId}`);
    return { deliveryId, sent: true };
  } catch {
    // Transport down (SMTP is env-gated and may simply not be configured).
    // The deliveries row records the intent; the crew's entry already stands.
    return { deliveryId, sent: false };
  }
}

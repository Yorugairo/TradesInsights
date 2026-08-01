import type { Metadata } from "next";
import { listFieldEntries, getFieldBrief, verifyFieldToken } from "@otn/intelligence";
import { db } from "../../../lib/db.js";
import FieldOfflineClient from "./offline-client.js";

/**
 * The crew surface (deck A5 "field communication"). Token-gated, NO session:
 * the link IS the credential, so this page follows the api/action hardening —
 * GET renders only (mail/chat gateways prefetch links; even last_used_at is
 * bumped by the POST path, not here), one neutral failure page for
 * invalid/expired/revoked alike (no oracle), noindex, and nothing beyond the
 * job brief: no contacts, no scores, no money the crew didn't submit.
 *
 * Plain HTML forms POSTing to /api/field/{token}/entries — works on any phone
 * with zero client JS, which is the entire point of the surface.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

const wrap: React.CSSProperties = { maxWidth: "32rem", margin: "0 auto", padding: "1rem", fontFamily: "system-ui, sans-serif" };
const card: React.CSSProperties = { border: "1px solid #ccc", borderRadius: 8, padding: "0.8rem", marginBottom: "1rem" };
const field: React.CSSProperties = { display: "block", width: "100%", boxSizing: "border-box", padding: "0.5rem", marginTop: "0.15rem", marginBottom: "0.6rem", fontSize: "1rem" };
const btn: React.CSSProperties = { fontSize: "1.05rem", padding: "0.6rem 1.4rem" };

export default async function FieldPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ok?: string }>;
}) {
  const { token } = await params;
  const { ok } = await searchParams;
  const verdict = await verifyFieldToken(db(), token);
  if (!verdict.ok) {
    return (
      <main style={wrap}>
        <h2>Link unavailable</h2>
        <p>This link is not valid. Ask the office for a fresh one.</p>
      </main>
    );
  }
  // Sequential reads on purpose — the web pool caps at 2 connections.
  const brief = await getFieldBrief(db(), verdict.pursuitId);
  if (!brief) {
    return (
      <main style={wrap}>
        <h2>Link unavailable</h2>
        <p>This link is not valid. Ask the office for a fresh one.</p>
      </main>
    );
  }
  const entries = await listFieldEntries(db(), verdict.pursuitId, { limit: 5 });
  const action = `/api/field/${encodeURIComponent(token)}/entries`;

  return (
    <main style={wrap} data-testid="field-page">
      <h1 style={{ fontSize: "1.3rem" }} data-testid="field-project-name">{brief.projectName}</h1>
      <p style={{ color: "#555" }}>
        {[brief.city, brief.county ? `${brief.county} County` : null].filter(Boolean).join(" · ") || "—"}
        {" · "}status: {brief.state.replaceAll("_", " ")}
        {brief.bidDueAt ? ` · bid due ${new Date(brief.bidDueAt).toISOString().slice(0, 10)}` : ""}
      </p>
      {/* Offline capture. Renders nothing when online with an empty queue, so
          the online experience is unchanged; see ADR-8 (progressive
          enhancement) in docs/design/MOBILE_DECISIONS.md. */}
      <FieldOfflineClient token={token} />

      {ok === "1" && (
        <p data-testid="field-submitted-ok" style={{ background: "#e6f4ea", border: "1px solid #b7dfc2", padding: "0.5rem", borderRadius: 6 }}>
          ✓ Submitted — the office can see it now.
        </p>
      )}

      <section style={card}>
        <h2 style={{ fontSize: "1.05rem" }}>Daily log</h2>
        <form method="post" action={action}>
          <input type="hidden" name="entryType" value="daily_log" />
          <label>Boards hung<input style={field} name="boards" inputMode="numeric" placeholder="e.g. 84" /></label>
          <label>Feet taped<input style={field} name="tapedLf" inputMode="numeric" placeholder="e.g. 310" /></label>
          <label>Crew hours<input style={field} name="crewHours" inputMode="numeric" placeholder="e.g. 27" /></label>
          <label>Notes<textarea style={field} name="body" rows={2} placeholder="what happened today" required /></label>
          <label>Your name<input style={field} name="submittedName" placeholder="who is logging" /></label>
          <button style={btn} type="submit" data-testid="field-log-submit">Submit log</button>
        </form>
      </section>

      <section style={card}>
        <h2 style={{ fontSize: "1.05rem" }}>Change order</h2>
        <p style={{ color: "#555", fontSize: "0.9rem" }}>
          Extra work not in the bid? Write it down BEFORE doing it — this goes straight to the
          office for approval.
        </p>
        <form method="post" action={action}>
          <input type="hidden" name="entryType" value="change_order" />
          <label>What changed<textarea style={field} name="body" rows={3} placeholder="e.g. water damage behind north wall — replace 12 boards" required /></label>
          <label>Rough extra cost $<input style={field} name="amount" inputMode="numeric" placeholder="e.g. 1850" /></label>
          <label>Your name (signature)<input style={field} name="submittedName" placeholder="required for change orders" required /></label>
          <button style={btn} type="submit" data-testid="field-co-submit">Send for approval</button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1.05rem" }}>Recent</h2>
        <ul style={{ paddingLeft: "1.1rem" }} data-testid="field-recent">
          {entries.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.3rem" }}>
              <em>{new Date(e.createdAt).toISOString().slice(0, 10)}</em>{" "}
              {e.entryType === "change_order" ? `CO (${e.status})` : e.entryType.replaceAll("_", " ")} — {e.body.slice(0, 90)}
            </li>
          ))}
          {entries.length === 0 && <li>nothing yet</li>}
        </ul>
      </section>
    </main>
  );
}

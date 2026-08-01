import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey, digestById } from "../../../../lib/queries.js";
import { fmtDate } from "../../../../lib/ui.js";

/**
 * The mobile digest reader — Milestone 1's user-visible outcome.
 *
 * RENDERS STORED CONTENT, NEVER REBUILDS (ADR-9). `deliveries.rendered_content`
 * is the HTML the worker already produced for the email. Calling `buildDigest()`
 * here could show a different week than the one the owner received, and a
 * digest's whole value is that it is a FIXED statement about a period.
 */

export const dynamic = "force-dynamic";

const article: React.CSSProperties = {
  maxWidth: "42rem",
  margin: "0 auto",
  lineHeight: 1.55,
  overflowWrap: "anywhere",
};

export default async function DigestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  // Sequential reads — the web pool caps at 2 connections, and a Promise.all of
  // two page reads has starved this app before.
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const digest = await digestById(db(), account.id, id);

  if (!digest) {
    return (
      <main style={article} data-testid="digest-not-found">
        <h1>Digest not found</h1>
        <p>This digest does not exist, or it belongs to another account.</p>
        <Link href="/app/digests">← All digests</Link>
      </main>
    );
  }

  return (
    <main style={article} data-testid="digest-detail">
      <p style={{ marginBottom: "0.25rem" }}>
        <Link href="/app/digests">← All digests</Link>
      </p>
      <h1 style={{ fontSize: "1.35rem", marginBottom: "0.2rem" }}>
        {digest.deliveryType.replaceAll("_", " ")}
      </h1>
      <p style={{ opacity: 0.75, marginTop: 0 }}>
        {fmtDate(digest.periodStart)} → {fmtDate(digest.periodEnd)} · {digest.status}
        {digest.sentAt ? ` · sent ${fmtDate(digest.sentAt)}` : ""}
      </p>

      {digest.renderedContent ? (
        // Our own worker-rendered HTML, the same body that went out by email —
        // same trust boundary, not user input.
        <article
          data-testid="digest-content"
          dangerouslySetInnerHTML={{ __html: digest.renderedContent }}
        />
      ) : (
        <p data-testid="digest-no-content">
          This delivery has no rendered content — it was drafted but never built. Nothing was
          lost; there is simply nothing to read yet.
        </p>
      )}
    </main>
  );
}

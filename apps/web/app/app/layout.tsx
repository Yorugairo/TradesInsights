import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentSession } from "../../lib/auth.js";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  return (
    <div>
      <nav
        style={{
          display: "flex",
          gap: "1rem",
          borderBottom: "1px solid #ddd",
          paddingBottom: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <strong>OTN Insights</strong>
        {session.accountKey && (
          <>
            <Link href="/app/pursuits">Pursuits</Link>
            <Link href="/app/opportunities">Opportunities</Link>
            <Link href="/app/digests">Digests</Link>
            <Link href="/app/invitations">Invitations</Link>
            <Link href="/app/organizations">Organizations</Link>
            <Link href="/app/feedback">Feedback</Link>
            <Link href="/app/account-profile">Account</Link>
          </>
        )}
        {session.role === "admin" && (
          <>
            <Link href="/app/admin/sources">Sources</Link>
            <Link href="/app/admin/review">Review queue</Link>
            <Link href="/app/admin/coverage">Coverage</Link>
          </>
        )}
        <span style={{ marginLeft: "auto", color: "#666" }} data-testid="session-info">
          {session.accountKey ?? "(no account)"} · {session.role}
        </span>
      </nav>
      {children}
    </div>
  );
}

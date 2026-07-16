import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>OTN Insights</h1>
      <p>
        Construction opportunity intelligence for trade contractors — sourced opportunity briefs
        and stage-change alerts from official public construction records in Thurston, Pierce,
        Lewis, and King counties.
      </p>
      <p>
        <Link href="/login">Sign in</Link> to view opportunities.
      </p>
      <p data-testid="m0-status">M0 scaffold: operational.</p>
    </main>
  );
}

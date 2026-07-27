import Link from "next/link";

export default function HomePage() {
  return (
    // Outside the app shell — see globals.css `.page-gutter`.
    <main className="page-gutter mx-auto max-w-[46rem]">
      <h1 className="text-2xl font-semibold text-ink">OTN Insights</h1>
      <p className="mt-2 text-ink-muted">
        Construction opportunity intelligence for trade contractors — sourced opportunity briefs
        and stage-change alerts from official public construction records in Thurston, Pierce,
        Lewis, and King counties.
      </p>
      <p className="mt-4">
        <Link href="/login" className="text-accent-ink underline underline-offset-2">
          Sign in
        </Link>{" "}
        <span className="text-ink-muted">to view opportunities.</span>
      </p>
      <p className="mt-6 text-xs text-ink-subtle" data-testid="m0-status">
        M0 scaffold: operational.
      </p>
    </main>
  );
}

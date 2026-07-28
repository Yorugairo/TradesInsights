"use client";

import { useEffect } from "react";

/**
 * Segment error boundary for the whole authenticated app.
 *
 * Before this existed, ANY server throw under `/app` rendered Next's default
 * page — "Application error: a server-side exception has occurred", a digest,
 * and nothing else. That is what an operator saw when the cockpit crossed
 * `statement_timeout`: no navigation, no explanation, no way back except the
 * browser's back button.
 *
 * Two things this must do that the default cannot:
 *
 *  - Keep the shell. This file lives at `app/app/error.tsx`, INSIDE the layout
 *    that renders `AppNav`, so the rail survives and the operator can leave.
 *    Putting it at the root would lose the nav along with the page.
 *  - Say something true. The digest is kept because it is the only handle
 *    server logs can be searched by, but it is not the message — a person needs
 *    a sentence and a button.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server already logged the stack; this is the client half of the same
    // event, so a browser-side session has something to correlate.
    console.error("[app] segment error", error.digest, error.message);
  }, [error]);

  return (
    <main className="mx-auto max-w-[46rem] py-8">
      <h1 className="text-2xl font-semibold text-ink">This page did not load.</h1>
      <p className="mt-2 max-w-[70ch] text-ink-muted">
        Something failed on the server while building this screen. Nothing was changed by the
        attempt — every page under <code>/app</code> that writes does so behind an explicit action,
        and a render failure never reaches one.
      </p>
      <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
        The most common cause here is a slow query against the registry seam. Retrying often works;
        if it does not, the digest below is what to search the server logs for.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={reset}
          className="inline-flex items-center rounded-sm border border-line-strong bg-[image:var(--panel-gold-bg)] px-3 py-2 text-sm font-semibold text-accent-ink"
        >
          Try again
        </button>
        <a
          href="/app/opportunities"
          className="text-sm text-ink underline decoration-line-strong underline-offset-2"
        >
          Back to opportunities
        </a>
      </div>

      {error.digest && (
        <p className="mt-6 text-2xs uppercase tracking-[0.08em] text-ink-subtle">
          Digest <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}

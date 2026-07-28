/**
 * Loading state for the ADMIN segment only.
 *
 * Every page under `/app` is `force-dynamic`, but only the admin queues are
 * slow enough to need this — with no `loading.tsx` the browser showed the
 * PREVIOUS page, frozen, for the whole duration (measured at up to 21s on the
 * cockpit and 109s on corporate families) with nothing to say a navigation was
 * even in progress.
 *
 * SCOPED TO `/app/admin`, NOT `/app`. It first went at the segment root, and
 * that was wrong: a `loading.tsx` makes Next swap page content on EVERY
 * navigation under it, so the sub-second customer pages paid a content swap for
 * no benefit — and the swap discards focus. The e2e caught it immediately: a
 * test that focused the opportunities filter input and pressed Cmd-K got the
 * command palette, because the input it had focused was replaced mid-keystroke.
 * A loading state that costs a fast page its focus is a downgrade.
 *
 * Because this file sits inside the layout that renders `AppNav`, the rail
 * stays live while the page streams: the operator can change their mind and go
 * somewhere else instead of waiting.
 *
 * Deliberately a shape, not a spinner. A skeleton matching the page's real
 * geometry says "this is arriving" rather than "this is busy", and it does not
 * animate a promise it cannot keep.
 */
export default function AdminLoading() {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-[calc(var(--stack)*1.5)]">
        <Bar className="h-7 w-[22rem] max-w-full" />
        <Bar className="mt-3 h-4 w-[34rem] max-w-full" />
      </div>

      <div className="mb-[calc(var(--stack)*1.5)] grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-md border border-line bg-surface px-[18px] py-4">
            <Bar className="h-7 w-20" />
            <Bar className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-line">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex gap-4 border-b border-line px-4 py-3 last:border-b-0">
            <Bar className="h-4 flex-1" />
            <Bar className="h-4 w-24" />
            <Bar className="h-4 w-16" />
          </div>
        ))}
      </div>
    </main>
  );
}

/**
 * `animate-pulse` is a Tailwind utility and respects the reduced-motion media
 * query only if the project disables animation there — globals.css does, via
 * the `prefers-reduced-motion` block, so this degrades to a static block.
 */
function Bar({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-sm bg-track ${className}`} />;
}

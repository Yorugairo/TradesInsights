import type { Metadata } from "next";

/**
 * The service worker's fallback when a page was never opened on this device.
 *
 * Deliberately reassuring about the thing that matters: anything the crew has
 * already typed is queued on the phone and will send itself. The failure here
 * is only that we cannot FETCH a page — never that we lost their work.
 */

export const metadata: Metadata = { robots: { index: false, follow: false } };

const wrap: React.CSSProperties = {
  maxWidth: "32rem",
  margin: "0 auto",
  padding: "2rem 1rem",
  fontFamily: "system-ui, sans-serif",
};

export default function OfflinePage() {
  return (
    <main style={wrap} data-testid="offline-page">
      <h1 style={{ fontSize: "1.3rem" }}>No signal</h1>
      <p>
        This page has not been opened on this phone yet, so there is nothing saved to show.
      </p>
      <p style={{ fontWeight: 600 }}>
        Anything you already submitted is saved on this phone and will send itself when you
        are back in signal.
      </p>
      <p style={{ color: "#555" }}>Try again once you have a bar or two.</p>
    </main>
  );
}

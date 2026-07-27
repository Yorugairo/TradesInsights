import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "OTN Insights",
  description: "Construction opportunity intelligence for trade contractors",
};

// P4 — mobile-first: proper viewport + responsive table behavior. Wide tables
// scroll inside themselves on phones instead of forcing page-level overflow.
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // DARK is the default register: Insights is a login-gated operator cockpit,
    // so there is no public-page reason to start light. [data-theme="light"]
    // switches registers at runtime and DensityToggle (Phase 2) owns
    // [data-density]. Both live on <html> rather than <body> so the custom
    // properties reach portals and dialogs too.
    <html lang="en" data-theme="dark" data-density="comfortable">
      <body>{children}</body>
    </html>
  );
}

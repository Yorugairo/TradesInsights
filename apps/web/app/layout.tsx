import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "OTN Insights",
  description: "Construction opportunity intelligence for trade contractors",
};

// P4 — mobile-first: proper viewport + responsive table behavior. Wide tables
// scroll inside themselves on phones instead of forcing page-level overflow.
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const GLOBAL_CSS = `
  body { font-family: system-ui, sans-serif; margin: 1rem; }
  @media (min-width: 768px) { body { margin: 2rem; } }
  table { display: block; overflow-x: auto; max-width: 100%; }
  @media (min-width: 900px) { table { display: table; } }
  input, select, button { font-size: 1rem; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

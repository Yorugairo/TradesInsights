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
    // NO `data-density` here, deliberately. React reconciles attributes it owns
    // during hydration, so a server-rendered `data-density="comfortable"` gets
    // restored over whatever the no-flash script below wrote — the saved
    // preference survived the paint and then died at hydration. Measured: the
    // e2e reload assertion failed with exactly that symptom. Leaving the
    // attribute off means React has no opinion and the script's value stands.
    // The token layer treats "absent" as comfortable (only `[data-density=
    // "compact"]` overrides), so the default is unchanged.
    <html lang="en" data-theme="dark">
      <body>
        {/*
          Applies the saved density BEFORE first paint. Without it the server
          always renders `comfortable` and a user who chose compact watches the
          page reflow on hydration — the classic preference flash. It runs
          first-child-of-body so nothing has painted yet, is wrapped in
          try/catch because localStorage throws in some privacy modes, and
          never touches anything but one data attribute.
          DensityToggle reads the DOM (not the server default) for the same reason.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=localStorage.getItem("otn.density");if(d==="compact"||d==="comfortable"){document.documentElement.dataset.density=d}}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}

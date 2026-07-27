"use client";

/**
 * The cockpit shell: a grouped navigation rail plus the content column.
 *
 * WHAT THIS REPLACES. A flat row of fourteen links with no grouping, no active
 * state, and no hierarchy — every destination shouting at the same volume,
 * which is the "data dump" complaint applied to navigation itself. Grouping
 * into Work / Find / Reach / Measure / Admin says what the product is for
 * before it says where the pages are.
 *
 * LAYOUT. A two-column grid above 1024px with a sticky rail; a stacked
 * disclosure below it. `minmax(0,1fr)` on the content column is load-bearing:
 * a bare `1fr` has an automatic minimum of min-content, so one wide table would
 * push the whole grid past the viewport. `app.spec.ts:303` asserts zero
 * horizontal overflow at 390x844 on three pages, and that is the failure it
 * would catch.
 *
 * CLIENT BOUNDARY. This component needs `usePathname` for active state, so it
 * is a client component — but it takes the session as PROPS from the server
 * layout and never reads auth itself. Children pass straight through, so every
 * page rendered inside stays a server component.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import CommandPalette from "./CommandPalette.js";
import DensityToggle from "./DensityToggle.js";
import { ACCOUNT_ITEM, isActive, NAV_GROUPS } from "./nav-items.js";

export default function AppNav({
  accountKey,
  role,
  children,
}: {
  accountKey: string | null;
  role: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Navigating on a phone must dismiss the menu, or the destination page opens
  // underneath an expanded nav and reads as "the click did nothing".
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const groups = NAV_GROUPS.filter((group) =>
    group.scope === "admin" ? role === "admin" : Boolean(accountKey),
  );

  return (
    <div className="lg:grid lg:min-h-dvh lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav
        aria-label="Primary"
        className="border-b border-line bg-surface lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-b-0 lg:border-r"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <Link href="/app/opportunities" className="font-semibold tracking-tight text-ink">
            OTN <span className="text-accent-ink">Insights</span>
          </Link>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="app-nav-groups"
            data-testid="nav-menu-toggle"
            className="rounded-md border border-line px-2 py-1 text-xs text-ink-muted lg:hidden"
          >
            {menuOpen ? "Close" : "Menu"}
          </button>
        </div>

        <div
          id="app-nav-groups"
          className={`${menuOpen ? "block" : "hidden"} px-3 pb-3 lg:block`}
        >
          <div className="mb-3 px-1">
            <CommandPalette accountKey={accountKey} role={role} />
          </div>

          {groups.map((group) => (
            <div key={group.id} className="mb-4">
              <div className="px-2 pb-1 text-2xs uppercase tracking-[0.08em] text-ink-subtle">
                {group.label}
              </div>
              <ul>
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={[
                          "block rounded-md px-2 py-[var(--row-pad-y)] text-sm",
                          // Active state is a gold left edge plus a lifted
                          // surface. Colour alone would fail for anyone who
                          // cannot distinguish it; aria-current carries it to
                          // assistive tech either way.
                          active
                            ? "border-l-2 border-accent bg-surface-raised font-semibold text-ink"
                            : "border-l-2 border-transparent text-ink-muted hover:bg-surface-raised hover:text-ink",
                        ].join(" ")}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <div className="mt-4 border-t border-line px-2 pt-3">
            {accountKey && (
              <Link
                href={ACCOUNT_ITEM.href}
                aria-current={isActive(pathname, ACCOUNT_ITEM.href) ? "page" : undefined}
                className={[
                  "mb-2 block rounded-md py-[var(--row-pad-y)] text-sm",
                  isActive(pathname, ACCOUNT_ITEM.href)
                    ? "font-semibold text-ink"
                    : "text-ink-muted hover:text-ink",
                ].join(" ")}
              >
                {ACCOUNT_ITEM.label}
              </Link>
            )}
            {/* PRESERVED EXACTLY. `app.spec.ts:52` asserts this testid contains
                the account key, and the "{account} · {role}" text is the only
                place either is visible. Restyling is fine; rewording is not. */}
            <div className="text-xs text-ink-subtle" data-testid="session-info">
              {accountKey ?? "(no account)"} · {role}
            </div>
            <div className="mt-2">
              <DensityToggle />
            </div>
          </div>
        </div>
      </nav>

      {/* The gutter every page used to get from `body { margin }`. It moved
          here, into the element that owns page framing, in the same change that
          removed it — see globals.css. */}
      <div className="min-w-0 px-4 py-4 md:px-8 md:py-6">{children}</div>
    </div>
  );
}

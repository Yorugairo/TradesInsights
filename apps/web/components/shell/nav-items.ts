/**
 * The route map for the cockpit shell.
 *
 * Data, not markup, because two surfaces consume it and they must never
 * disagree: `AppNav` renders the curated rail, `CommandPalette` searches
 * everything. Keeping one list means a new page cannot be added to the nav and
 * forgotten by the palette, or vice versa.
 *
 * WHY THE RAIL IS SHORTER THAN THE PALETTE. The four deep review lanes
 * (registry-review, corporate-families, google-place-review,
 * google-place-contested) are deliberately absent from the rail. The Queue
 * cockpit is their declared front door — it states the mission, orders the
 * lanes by the owner's priority, and shows a dormant lane's reason for being
 * dormant. Listing them flat in a sidebar would present six equal tabs and
 * throw that ordering away. They stay one keystroke from anywhere via the
 * palette, which is a different promise than "reachable only from inside",
 * the bug this shell exists to fix.
 */

export type NavItem = {
  href: string;
  label: string;
  /** Extra words the palette should match on. Never rendered. */
  keywords?: string;
};

export type NavGroup = {
  id: string;
  label: string;
  /** `account` groups render only with an accountKey; `admin` only for admins. */
  scope: "account" | "admin";
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "work",
    label: "Work",
    scope: "account",
    items: [
      { href: "/app/pipeline", label: "Pipeline", keywords: "stages funnel" },
      { href: "/app/pursuits", label: "Pursuits", keywords: "bids chasing" },
      { href: "/app/opportunities", label: "Opportunities", keywords: "leads projects list" },
    ],
  },
  {
    id: "find",
    label: "Find",
    scope: "account",
    items: [
      { href: "/app/map", label: "Map", keywords: "geography location markers" },
      { href: "/app/radar", label: "Radar", keywords: "early stage upcoming" },
    ],
  },
  {
    id: "reach",
    label: "Reach",
    scope: "account",
    items: [
      { href: "/app/digests", label: "Digests", keywords: "email alerts delivery" },
      { href: "/app/invitations", label: "Invitations", keywords: "itb upload bid" },
      { href: "/app/organizations", label: "Organizations", keywords: "gc contractors companies" },
    ],
  },
  {
    id: "measure",
    label: "Measure",
    scope: "account",
    items: [
      { href: "/app/roi", label: "ROI", keywords: "scorecard outcomes backtest" },
      { href: "/app/feedback", label: "Feedback", keywords: "disposition rating" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    scope: "admin",
    items: [
      { href: "/app/admin/cockpit", label: "Cockpit", keywords: "queues front door" },
      { href: "/app/admin/sources", label: "Sources", keywords: "fleet health runs" },
      { href: "/app/admin/review", label: "Review queue", keywords: "resolution clusters triage" },
      { href: "/app/admin/coverage", label: "Coverage", keywords: "geometry counties geocode" },
    ],
  },
];

/** Reachable from the rail's footer rather than a group — it is about you, not the work. */
export const ACCOUNT_ITEM: NavItem = {
  href: "/app/account-profile",
  label: "Account",
  keywords: "profile trades territory preferences",
};

/** Admin lanes the cockpit owns the ordering of; palette-only. See the note above. */
const ADMIN_LANES: NavItem[] = [
  { href: "/app/admin/registry-review", label: "Registry review", keywords: "bindings identity tier" },
  { href: "/app/admin/corporate-families", label: "Corporate families", keywords: "principal ubi parent" },
  { href: "/app/admin/google-place-review", label: "Google Place review", keywords: "places match entity" },
  { href: "/app/admin/google-place-contested", label: "Google Place contested", keywords: "conflicts licence" },
];

/**
 * Everything the palette can jump to, filtered by what the session may see.
 * Mirrors the same two conditions the rail applies — a palette that offered an
 * admin route to a customer would be an authorization bug with a nice UI.
 */
export function commandRoutes(accountKey: string | null, role: string): NavItem[] {
  const routes: NavItem[] = [];
  for (const group of NAV_GROUPS) {
    if (group.scope === "account" && !accountKey) continue;
    if (group.scope === "admin" && role !== "admin") continue;
    routes.push(...group.items);
  }
  if (accountKey) routes.push(ACCOUNT_ITEM);
  if (role === "admin") routes.push(...ADMIN_LANES);
  return routes;
}

/**
 * A link is active for its own path and anything nested under it. The trailing
 * slash matters: without it `/app/admin/review` would light up on
 * `/app/admin/registry-review`, which is a different queue.
 */
export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

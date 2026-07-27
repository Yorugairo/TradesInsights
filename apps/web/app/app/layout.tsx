import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import AppNav from "../../components/shell/AppNav.js";
import { currentSession } from "../../lib/auth.js";

export const dynamic = "force-dynamic";

/**
 * The authenticated shell.
 *
 * Auth stays here, in a server component. `AppNav` is a client component (it
 * needs `usePathname` for active state) and receives the session as two plain
 * props — it never reads a cookie or calls `currentSession` itself. Children
 * pass through untouched, so every page below remains a server component.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  return (
    <AppNav accountKey={session.accountKey ?? null} role={session.role}>
      {children}
    </AppNav>
  );
}

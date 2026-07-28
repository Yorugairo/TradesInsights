import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fieldRollup, getOrCreateTakeoffSheet, getPursuitDetail } from "@otn/intelligence";
import { currentSession } from "../../../../../lib/auth.js";
import { db } from "../../../../../lib/db.js";
import { accountByKey } from "../../../../../lib/queries.js";
import { SheetEditor } from "./sheet-editor.js";

export const dynamic = "force-dynamic";

/**
 * The takeoff worksheet (deck A6: estimate, then measure yourself against it).
 * Visiting THIS page is the explicit "start takeoff" act, so get-or-create is
 * correct here (unlike the pursuit detail page, which only peeks).
 */
export default async function TakeoffPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const p = await getPursuitDetail(db(), id);
  if (!p || p.accountProfileId !== account.id) notFound();
  // Sequential reads — the web pool caps at 2 connections.
  const sheet = await getOrCreateTakeoffSheet(db(), {
    id: p.id,
    accountProfileId: p.accountProfileId,
    opportunityId: p.opportunityId,
  });
  const rollup = await fieldRollup(db(), p.id);

  return (
    <main>
      <h1 data-testid="takeoff-title">Takeoff — {p.projectName}</h1>
      <p>
        <Link href={`/app/pursuits/${p.id}`}>back to pursuit</Link> · every derived figure is an{" "}
        <strong>estimate</strong> from permit text, not a measured drawing — your edits win, and
        re-derive never touches a line you have edited.
      </p>
      <SheetEditor pursuitId={p.id} sheet={sheet} rollup={rollup} />
    </main>
  );
}

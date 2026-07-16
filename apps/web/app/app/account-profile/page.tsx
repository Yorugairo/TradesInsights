import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, accountRules } from "../../../lib/queries.js";

export const dynamic = "force-dynamic";

export default async function AccountProfilePage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const rules = await accountRules(db(), account.id);

  return (
    <main>
      <h1>Account profile — {account.name}</h1>
      <h2>Capabilities</h2>
      <pre>{JSON.stringify(account.capabilities, null, 2)}</pre>
      <h2>Territory</h2>
      <pre>{JSON.stringify(account.territory, null, 2)}</pre>
      <h2>Exclusions</h2>
      <pre>{JSON.stringify(account.exclusions, null, 2)}</pre>
      <h2>Delivery thresholds</h2>
      <pre>{JSON.stringify(account.delivery, null, 2)}</pre>
      <h2>Rules (latest versions — append-only, edits create new versions)</h2>
      {rules.map((r) => (
        <details key={r.ruleType}>
          <summary>
            {r.ruleType} — v{r.version}
          </summary>
          <pre>{JSON.stringify(r.rule, null, 2)}</pre>
        </details>
      ))}
    </main>
  );
}

import { db } from "../../lib/db.js";
import { listAccounts } from "../../lib/queries.js";
import { LoginForm } from "./LoginForm.js";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const accounts = await listAccounts(db());
  return (
    <main>
      <h1>Sign in</h1>
      <p>Pilot access uses the shared passphrase; customer sessions are scoped to one account.</p>
      <LoginForm accounts={accounts} />
    </main>
  );
}

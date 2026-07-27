import { db } from "../../lib/db.js";
import { listAccounts } from "../../lib/queries.js";
import { LoginForm } from "./LoginForm.js";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const accounts = await listAccounts(db());
  return (
    // `page-gutter` because /login sits OUTSIDE the app shell, and Phase 2
    // removed the body margin that used to give it one. Tokens only here — the
    // login page is not part of the cockpit retrofit.
    <main className="page-gutter mx-auto max-w-[28rem]">
      <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
      <p className="mt-1 mb-5 text-ink-muted">
        Pilot access uses the shared passphrase; customer sessions are scoped to one account.
      </p>
      <LoginForm accounts={accounts} />
    </main>
  );
}

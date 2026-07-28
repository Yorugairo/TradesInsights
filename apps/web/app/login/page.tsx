import { db } from "../../lib/db.js";
import { listAccounts } from "../../lib/queries.js";
import { LoginForm } from "./LoginForm.js";

export const dynamic = "force-dynamic";

/** Cap on the message banner — the param is attacker-writable URL input, and
 * an unbounded string would let anyone paint a paragraph onto the login page. */
const MAX_MESSAGE_LENGTH = 160;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const accounts = await listAccounts(db());
  // Set by /api/auth/sso when a handoff is refused — without it, an expired
  // link would bounce the customer to a login page that explains nothing.
  // Rendered as TEXT (React escapes it) and truncated; never interpreted.
  const message = (await searchParams).message?.slice(0, MAX_MESSAGE_LENGTH);
  return (
    // `page-gutter` because /login sits OUTSIDE the app shell, and Phase 2
    // removed the body margin that used to give it one. Tokens only here — the
    // login page is not part of the cockpit retrofit.
    <main className="page-gutter mx-auto max-w-[28rem]">
      <h1 className="text-2xl font-semibold text-ink">Sign in</h1>
      {message && (
        <p
          data-testid="login-message"
          className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          {message}
        </p>
      )}
      <p className="mt-1 mb-5 text-ink-muted">
        Pilot access uses the shared passphrase; customer sessions are scoped to one account.
      </p>
      <LoginForm accounts={accounts} />
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm({ accounts }: { accounts: { key: string; name: string }[] }) {
  const router = useRouter();
  const [role, setRole] = useState<"customer" | "admin">("customer");
  const [accountKey, setAccountKey] = useState(accounts[0]?.key ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password,
        role,
        accountKey: role === "customer" ? accountKey : accountKey || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `login failed (${res.status})`);
      return;
    }
    router.push(role === "admin" ? "/app/admin/sources" : "/app/opportunities");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid max-w-[22.5rem] gap-3">
      <label>
        Role{" "}
        <select value={role} onChange={(e) => setRole(e.target.value as "customer" | "admin")} data-testid="login-role">
          <option value="customer">customer</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label>
        Account{" "}
        <select value={accountKey} onChange={(e) => setAccountKey(e.target.value)} data-testid="login-account">
          {role === "admin" && <option value="">(none — admin only)</option>}
          {accounts.map((a) => (
            <option key={a.key} value={a.key}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Passphrase{" "}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="login-password"
          autoComplete="current-password"
        />
      </label>
      <button type="submit" disabled={busy} data-testid="login-submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && (
        <p role="alert" className="font-semibold text-bad" data-testid="login-error">
          {error}
        </p>
      )}
    </form>
  );
}

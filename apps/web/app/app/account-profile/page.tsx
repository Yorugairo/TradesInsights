import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, accountRules, type AccountView } from "../../../lib/queries.js";
import { Badge, fmtDate, fmtMoney } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

/**
 * Your profile — the customer-facing view of how their feed is configured.
 *
 * This page used to render four `JSON.stringify(..., null, 2)` blocks. That is
 * fine for an operator who wrote the schema and useless to the contractor whose
 * business it describes: it shows the VALUE of every setting and the MEANING of
 * none of them. A customer reading "radius_bands_mi: [20,35,50]" cannot tell
 * whether that is why a job they wanted never reached them.
 *
 * So every setting here is rendered with the one sentence that matters: what it
 * changes about what you receive. Anything we cannot explain in those terms
 * probably should not be a customer-visible setting at all.
 *
 * Read-only by design. Settings change through a calibration conversation and
 * are versioned (§12.3) — never silently, and never from a form on this page.
 */
export default async function AccountProfilePage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const rules = await accountRules(db(), account.id);

  return (
    <main style={{ padding: "1rem", maxWidth: 900 }}>
      <h1 style={{ marginBottom: "0.2rem" }}>Your profile</h1>
      <p style={{ color: "#666", margin: "0 0 1rem" }}>
        How <strong>{account.name}</strong>&apos;s feed is tuned, and what each setting changes.
      </p>

      <Orientation />
      <TerritorySection territory={account.territory} />
      <CapabilitiesSection capabilities={account.capabilities} />
      <ThresholdsSection delivery={account.delivery} />
      <EasyWinSection easyWin={account.delivery.easy_win} />
      <ExclusionsSection exclusions={account.exclusions} />
      <RulesSection rules={rules} />
    </main>
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "0.8rem 1rem",
  margin: "0.75rem 0",
};

const effectStyle: React.CSSProperties = {
  color: "#555",
  fontSize: "0.88rem",
  margin: "0.35rem 0 0",
  borderLeft: "3px solid #ccc",
  paddingLeft: "0.6rem",
};

/** A titled block with the plain-English consequence stated under the value. */
function Setting({
  title,
  effect,
  children,
}: {
  title: string;
  effect: string;
  children: React.ReactNode;
}) {
  return (
    <section style={panel}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h2>
      <div style={{ margin: "0.5rem 0 0" }}>{children}</div>
      <p style={effectStyle}>{effect}</p>
    </section>
  );
}

function Empty({ what }: { what: string }) {
  // Never render an empty section as if it were configured-and-blank; an unset
  // setting and a setting set to nothing mean different things to a customer.
  return <span style={{ color: "#999" }}>No {what} configured.</span>;
}

function Orientation() {
  return (
    <details open style={{ ...panel, background: "#fafafa" }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>How these settings get changed</summary>
      <p style={{ color: "#444", fontSize: "0.9rem", margin: "0.5rem 0 0" }}>
        This page is read-only. Anything here changes only in a calibration conversation, and every
        change is versioned and dated — so a shift in what you receive can always be traced back to
        something you actually asked for. If a setting looks wrong, say so and it gets changed with a
        record of why.
      </p>
    </details>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

interface Territory {
  counties_included?: string[];
  counties_excluded?: string[];
  notes?: string;
}

function TerritorySection({ territory }: { territory: unknown }) {
  const t = (territory ?? {}) as Territory;
  const included = t.counties_included ?? [];
  const excluded = t.counties_excluded ?? [];
  return (
    <Setting
      title="Where we look"
      effect="A county that is not on this list is invisible to you — however good the job."
    >
      {included.length === 0 ? (
        <Empty what="territory" />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
          {included.map((c) => (
            <Badge key={c} tone="green">
              {c}
            </Badge>
          ))}
          {excluded.map((c) => (
            <Badge key={c} tone="red">
              {c} — excluded
            </Badge>
          ))}
        </div>
      )}
      {t.notes && (
        <p style={{ color: "#666", fontSize: "0.85rem", margin: "0.5rem 0 0" }}>{t.notes}</p>
      )}
    </Setting>
  );
}

function CapabilitiesSection({ capabilities }: { capabilities: unknown }) {
  const list = Array.isArray(capabilities) ? (capabilities as string[]) : [];
  return (
    <Setting
      title="What counts as your work"
      effect="We read the text of each permit and match it against these trades. A trade missing here means those jobs never reach you."
    >
      {list.length === 0 ? (
        <Empty what="trades" />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
          {list.map((c) => (
            <Badge key={c} tone="gray">
              {c.replace(/_/g, " ")}
            </Badge>
          ))}
        </div>
      )}
    </Setting>
  );
}

function ThresholdsSection({ delivery }: { delivery: AccountView["delivery"] }) {
  const priority = delivery.priority_review_min;
  const digest = delivery.weekly_digest_min;
  return (
    <Setting
      title="How much reaches you"
      effect="Raising the priority score sends you less; lowering it sends you more. Neither changes what we find — only what we put in front of you."
    >
      {priority === undefined && digest === undefined ? (
        <Empty what="thresholds" />
      ) : (
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.92rem" }}>
          {priority !== undefined && (
            <li>
              Scores <strong>{priority} and above</strong> reach you as priority.
            </li>
          )}
          {digest !== undefined && priority !== undefined && (
            <li>
              <strong>
                {digest}–{priority - 1}
              </strong>{" "}
              go to the weekly digest instead — worth knowing, not worth interrupting you.
            </li>
          )}
          {digest !== undefined && (
            <li style={{ color: "#666" }}>Below {digest} we track it, but do not send it.</li>
          )}
        </ul>
      )}
    </Setting>
  );
}

function EasyWinSection({ easyWin }: { easyWin: AccountView["delivery"]["easy_win"] }) {
  if (!easyWin) return null;
  const bands = easyWin.radius_bands_mi ?? null;
  const floor = easyWin.min_valuation_usd;
  const cap = easyWin.max_valuation_usd;
  return (
    <Setting
      title="⚡ Winnable now"
      effect="These rules decide the short list at the top of your digest — the jobs close enough, recent enough, and the right size to act on today."
    >
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.92rem" }}>
        {bands && bands.length > 0 ? (
          <li>
            Ordered by distance, nearest first:{" "}
            <strong>{bands.map((b) => `${b} mi`).join(" → ")}</strong>.
          </li>
        ) : (
          easyWin.radius_km != null && (
            <li>
              Within <strong>{Math.round(easyWin.radius_km * 0.621371)} miles</strong> of your home
              point.
            </li>
          )
        )}
        {easyWin.max_age_days != null && (
          <li>
            Changed in the last <strong>{easyWin.max_age_days} days</strong> — older than that and we
            stop calling it winnable.
          </li>
        )}
        <li>
          {floor == null ? (
            <>
              <strong>No minimum job size</strong> — no job is too small.
            </>
          ) : (
            <>
              At least <strong>{fmtMoney(floor)}</strong>.
            </>
          )}
          {cap != null && <> Capped at {fmtMoney(cap)} — bigger work is a different conversation.</>}
        </li>
      </ul>
    </Setting>
  );
}

function ExclusionsSection({ exclusions }: { exclusions: unknown }) {
  const list = normalizeExclusions(exclusions);
  if (list.length === 0) return null;
  return (
    <Setting
      title="Never show me these"
      effect="Hard filters. Anything matching is removed before scoring — it will not appear in any digest."
    >
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.92rem" }}>
        {list.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </Setting>
  );
}

/** Exclusions are stored loosely (array, or an object of keyed lists), so flatten
 * to displayable strings rather than assuming one shape and rendering "[object
 * Object]" at a customer. */
function normalizeExclusions(exclusions: unknown): string[] {
  if (Array.isArray(exclusions)) return exclusions.map(String);
  if (exclusions && typeof exclusions === "object") {
    return Object.entries(exclusions as Record<string, unknown>).flatMap(([k, v]) => {
      const label = k.replace(/_/g, " ");
      if (Array.isArray(v)) return v.map((item) => `${label}: ${String(item)}`);
      if (v == null || v === "") return [];
      return [`${label}: ${String(v)}`];
    });
  }
  return [];
}

const RULE_MEANING: Record<string, string> = {
  routing: "Which kinds of project we steer toward you, and how we rank them against each other.",
  exclusion: "Records we refuse to attribute to you — usually a closed legal entity sharing your name.",
};

function RulesSection({
  rules,
}: {
  rules: { ruleType: string; version: number; effectiveAt: string; rule: unknown }[];
}) {
  if (rules.length === 0) return null;
  return (
    <section style={panel}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Routing rules</h2>
      <p style={{ color: "#666", fontSize: "0.85rem", margin: "0.25rem 0 0.6rem" }}>
        Rules are append-only — an edit creates a new version rather than overwriting the old one, so
        the history of what your feed did and when stays intact.
      </p>
      {rules.map((r) => (
        <details key={r.ruleType} style={{ marginBottom: "0.4rem" }}>
          <summary style={{ cursor: "pointer" }}>
            <strong>{r.ruleType.replace(/_/g, " ")}</strong>{" "}
            <span style={{ color: "#999" }}>
              v{r.version} · in effect since {fmtDate(r.effectiveAt)}
            </span>
          </summary>
          {RULE_MEANING[r.ruleType] && (
            <p style={{ ...effectStyle, marginTop: "0.4rem" }}>{RULE_MEANING[r.ruleType]}</p>
          )}
          <RuleBody rule={r.rule} />
        </details>
      ))}
    </section>
  );
}

/** Rule bodies are free-form JSON per rule type. Render the common
 * `{ key: string[] }` shape as readable lists and fall back to formatted JSON
 * only for shapes we have not taught the page to read. */
function RuleBody({ rule }: { rule: unknown }) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return <pre style={preStyle}>{JSON.stringify(rule, null, 2)}</pre>;
  }
  const entries = Object.entries(rule as Record<string, unknown>);
  const readable = entries.every(
    ([, v]) => typeof v === "string" || (Array.isArray(v) && v.every((i) => typeof i === "string")),
  );
  if (!readable) return <pre style={preStyle}>{JSON.stringify(rule, null, 2)}</pre>;

  return (
    <dl style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginBottom: "0.35rem" }}>
          <dt style={{ fontWeight: 600 }}>{k.replace(/_/g, " ")}</dt>
          <dd style={{ margin: "0.1rem 0 0 1rem", color: "#444" }}>
            {Array.isArray(v) ? v.map((i) => String(i).replace(/_/g, " ")).join(", ") : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const preStyle: React.CSSProperties = {
  background: "#f6f6f4",
  padding: "0.5rem",
  overflowX: "auto",
  fontSize: "0.8rem",
  margin: "0.4rem 0 0",
};

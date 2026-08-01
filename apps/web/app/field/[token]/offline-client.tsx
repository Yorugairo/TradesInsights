"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Offline capture for the crew surface (mobile M0/M2 groundwork).
 *
 * PROGRESSIVE ENHANCEMENT, NEVER REPLACEMENT (ADR-8). The page it mounts into
 * is plain HTML forms with zero client JS, and its header says that is "the
 * entire point of the surface". So this component intercepts a submit only to
 * RESCUE one that would otherwise be lost: online with an empty queue, it lets
 * the browser post the form natively and does nothing at all. If this bundle
 * fails to load, the page behaves exactly as it did before it existed.
 *
 * NO SERVER IMPORTS. This is a client component in a route whose siblings
 * import `@otn/intelligence` and the pg-backed `db()`; pulling either into the
 * module graph here would bundle `pg` for the browser and break the build.
 *
 * Idempotency: every queued entry carries a device-minted `clientEntryId`
 * reused across retries, which the server enforces with a partial unique index
 * (migration 0042). Without it a retry that crossed a lost response would write
 * the day's log twice.
 */

const DB_NAME = "otn-field-outbox";
const STORE = "entries";
const DB_VERSION = 1;

type Queued = {
  clientEntryId: string;
  token: string;
  fields: Record<string, string>;
  createdAt: number;
  /** Set when the server refused permanently (e.g. the link was revoked). The
   * row STAYS so the crew can still read and copy what they typed. */
  failedReason?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "clientEntryId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const putEntry = (e: Queued) => tx("readwrite", (s) => s.put(e) as IDBRequest<IDBValidKey>);
const deleteEntry = (id: string) => tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
const allEntries = () => tx<Queued[]>("readonly", (s) => s.getAll() as IDBRequest<Queued[]>);

export default function FieldOfflineClient({ token }: { token: string }) {
  const [queue, setQueue] = useState<Queued[]>([]);
  const [flushing, setFlushing] = useState(false);
  const [online, setOnline] = useState(true);
  // Guards against two triggers (online + visibilitychange fire together when a
  // phone wakes) flushing the same rows twice.
  const flushLock = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setQueue(await allEntries());
    } catch {
      /* IndexedDB unavailable (private mode) — the native form path still works */
    }
  }, []);

  const flush = useCallback(async () => {
    if (flushLock.current || !navigator.onLine) return;
    flushLock.current = true;
    setFlushing(true);
    try {
      const pending = (await allEntries()).filter((e) => !e.failedReason);
      // SEQUENTIAL, deliberately: the entries endpoint rate-limits at 30/min
      // per IP, so a parallel flush of a real backlog would trip its own
      // limiter and look like a server fault.
      for (const entry of pending) {
        let res: Response;
        try {
          res = await fetch(`/api/field/${encodeURIComponent(entry.token)}/entries`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...entry.fields, clientEntryId: entry.clientEntryId }),
          });
        } catch {
          break; // network died again — hold the queue, retry on the next trigger
        }
        if (res.ok) {
          // 201 stored, 200 deduped — both mean the server has it.
          await deleteEntry(entry.clientEntryId);
          continue;
        }
        if (res.status === 429) break; // limiter — hold, do not burn the queue
        if (res.status >= 500) break; // server trouble — hold
        // 4xx other than 429 is permanent (revoked link, invalid payload).
        // Mark it visible rather than silently dropping a crew's words.
        await putEntry({
          ...entry,
          failedReason:
            res.status === 404
              ? "This link is no longer valid — copy your text and ask the office for a new link."
              : "The office could not accept this entry. Copy your text before closing.",
        });
      }
      await refresh();
    } finally {
      flushLock.current = false;
      setFlushing(false);
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void refresh();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setOnline(navigator.onLine);
        void flush();
      }
    };

    // iOS has NO Background Sync API (ADR-4): a service-worker `sync` handler
    // would never fire. Replay is page-driven — these three are the triggers.
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    void flush();

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [flush, refresh]);

  useEffect(() => {
    const onSubmit = (event: Event) => {
      const form = event.target as HTMLFormElement;
      if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "post") return;

      // preventDefault MUST happen synchronously. An `await` before it — even
      // one IndexedDB read — lets the browser proceed with the submission and
      // the call silently does nothing: offline, that means a network error
      // page and the crew's typed text gone. (Caught by the e2e offline test,
      // which is exactly the failure it exists to catch.)
      event.preventDefault();

      // Read the form NOW too: `form.reset()` later, or navigation, would
      // otherwise race the async work below.
      const data = new FormData(form);
      const fields: Record<string, string> = {};
      for (const [k, v] of data.entries()) if (typeof v === "string") fields[k] = v;

      void (async () => {
        // Online with nothing queued → hand it straight back to the browser.
        // `form.submit()` does not re-fire this listener, so there is no loop.
        // Queue-first whenever a backlog exists, or ordering would invert.
        let backlog = 0;
        try {
          backlog = (await allEntries()).filter((e) => !e.failedReason).length;
        } catch {
          form.submit(); // no IndexedDB (private mode) — native is the only path
          return;
        }
        if (navigator.onLine && backlog === 0) {
          form.submit();
          return;
        }

        const entry: Queued = {
          clientEntryId: crypto.randomUUID(),
          token,
          fields,
          createdAt: Date.now(),
        };
        try {
          await putEntry(entry);
        } catch {
          form.submit(); // could not persist — better to try the network than drop it
          return;
        }
        // Ask the browser not to evict us. Best-effort: Safari may refuse, which
        // is exactly what the ADR-6 device spike is meant to measure.
        try {
          await navigator.storage?.persist?.();
        } catch {
          /* not fatal */
        }
        form.reset();
        await refresh();
        void flush();
      })();
    };

    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, [token, refresh, flush]);

  const pending = queue.filter((e) => !e.failedReason);
  const failed = queue.filter((e) => e.failedReason);
  if (pending.length === 0 && failed.length === 0 && online) return null;

  return (
    <section
      data-testid="field-outbox"
      data-pending={pending.length}
      data-failed={failed.length}
      style={{
        border: "1px solid #b7935a",
        background: "#fff8e6",
        borderRadius: 8,
        padding: "0.7rem 0.9rem",
        marginBottom: "1rem",
      }}
    >
      {!online && (
        <p style={{ margin: "0 0 0.4rem", fontWeight: 600 }} data-testid="field-offline-banner">
          No signal — your entries are saved on this phone.
        </p>
      )}
      {pending.length > 0 && (
        <p style={{ margin: "0 0 0.4rem" }} data-testid="field-outbox-pending">
          {pending.length} {pending.length === 1 ? "entry" : "entries"} waiting to send
          {flushing ? " — sending now…" : online ? " — will send shortly" : ""}.
        </p>
      )}
      {failed.map((e) => (
        <div key={e.clientEntryId} data-testid="field-outbox-failed" style={{ marginTop: "0.5rem" }}>
          <strong>Could not send.</strong> {e.failedReason}
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#fff",
              border: "1px solid #ddd",
              padding: "0.4rem",
              marginTop: "0.3rem",
              fontSize: "0.9rem",
            }}
          >
            {e.fields["body"] ?? ""}
          </pre>
        </div>
      ))}
    </section>
  );
}

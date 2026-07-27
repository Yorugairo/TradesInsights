"use client";

/**
 * Cmd/Ctrl-K route jump.
 *
 * Built on the native <dialog> element rather than a portal + a hand-rolled
 * focus trap. `showModal()` gives inert background, Escape-to-close, and a real
 * focus trap from the platform — three things that are easy to write badly and
 * that a keyboard-only operator notices immediately when they are wrong.
 *
 * The palette reaches every route the session is allowed to see, including the
 * four deep review lanes the rail deliberately omits (see nav-items.ts). That
 * is the point: the rail curates, the palette is exhaustive.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commandRoutes, type NavItem } from "./nav-items.js";

/** True when the keystroke belongs to whatever the user is typing in. */
function isEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  // Cmd-K is a text-navigation shortcut in some inputs and a "clear line" in
  // others. Stealing it while someone is typing a filter is worse than not
  // having a palette.
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

function score(item: NavItem, query: string): boolean {
  if (!query) return true;
  const haystack = `${item.label} ${item.keywords ?? ""} ${item.href}`.toLowerCase();
  // Every whitespace-separated term must appear somewhere. "rev que" finds
  // "Review queue" without needing the words adjacent or in order.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export default function CommandPalette({
  accountKey,
  role,
}: {
  accountKey: string | null;
  role: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const routes = useMemo(() => commandRoutes(accountKey, role), [accountKey, role]);
  const results = useMemo(() => routes.filter((r) => score(r, query)), [routes, query]);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // Global hotkey.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
      // Inside the palette's own input the hotkey should close, not be ignored.
      if (!open && isEditingContext(event.target)) return;
      event.preventDefault();
      if (open) close();
      else {
        setQuery("");
        setCursor(0);
        dialogRef.current?.showModal();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Escape and backdrop dismissal go through the platform, so state has to
  // follow the element rather than the other way round.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => setOpen(false);
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  function go(item: NavItem | undefined) {
    if (!item) return;
    close();
    router.push(item.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[cursor]);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setCursor(0);
          dialogRef.current?.showModal();
          setOpen(true);
        }}
        data-testid="command-palette-trigger"
        className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-canvas px-2 py-1.5 text-xs text-ink-subtle hover:border-line-strong hover:text-ink-muted"
      >
        <span>Jump to…</span>
        <kbd className="rounded border border-line px-1 text-2xs text-ink-subtle">⌘K</kbd>
      </button>

      <dialog
        ref={dialogRef}
        data-testid="command-palette"
        aria-label="Jump to a page"
        // `m-auto` overrides the UA centring for a top-anchored palette;
        // backdrop:* styles the ::backdrop pseudo-element.
        className="mx-auto mt-[12vh] w-[min(32rem,92vw)] rounded-lg border border-line-strong bg-surface p-0 text-ink backdrop:bg-black/50"
      >
        <div className="border-b border-line p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to a page…"
            aria-label="Search pages"
            data-testid="command-palette-input"
            className="w-full bg-transparent px-2 py-1.5 text-ink outline-none placeholder:text-ink-subtle"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1" role="listbox" aria-label="Pages">
          {results.map((item, i) => (
            <li key={item.href}>
              <button
                type="button"
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(item)}
                className={[
                  "flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left text-sm",
                  i === cursor ? "bg-chip text-ink" : "text-ink-muted",
                ].join(" ")}
              >
                <span>{item.label}</span>
                <span className="text-2xs text-ink-subtle">{item.href}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-ink-subtle">
              No page matches “{query}”.
            </li>
          )}
        </ul>
      </dialog>
    </>
  );
}

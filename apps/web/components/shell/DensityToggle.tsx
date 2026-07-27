"use client";

/**
 * Comfortable / Compact.
 *
 * Density is not a theme preference dressed up — it is the difference between
 * an operator seeing 12 rows and seeing 30 on the same screen. The token layer
 * already reads `[data-density]` for row padding and stack rhythm, so this
 * component's whole job is to set one attribute and remember it.
 *
 * A leaf client component on purpose. It sits inside a server-rendered nav, so
 * the `"use client"` boundary stops here and every page above stays a server
 * component.
 *
 * NO-FLASH: the initial value is applied by an inline script in app/layout.tsx
 * before first paint. This component must therefore READ the DOM on mount
 * rather than assume the server default, or the button would say "Comfortable"
 * on a page the script already made compact.
 */

import { useEffect, useState } from "react";

export const DENSITY_STORAGE_KEY = "otn.density";

type Density = "comfortable" | "compact";

export default function DensityToggle() {
  const [density, setDensity] = useState<Density | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset["density"];
    setDensity(current === "compact" ? "compact" : "comfortable");
  }, []);

  function apply(next: Density) {
    document.documentElement.dataset["density"] = next;
    setDensity(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // Private mode / storage disabled. The toggle still works for this
      // session; only the memory is lost. Never let a preference break a page.
    }
  }

  // Until the effect runs we do not know the real state. Rendering a definite
  // label here would flash the wrong one on a compact page.
  const isCompact = density === "compact";
  const label = density === null ? "Density" : isCompact ? "Compact" : "Comfortable";

  return (
    <button
      type="button"
      onClick={() => apply(isCompact ? "comfortable" : "compact")}
      aria-pressed={isCompact}
      title="Toggle row density"
      data-testid="density-toggle"
      // `unknown` until the effect runs, which makes this the shell's honest
      // hydration signal: the server cannot render anything else. e2e waits on
      // it instead of guessing how long hydration takes under load.
      data-state={density ?? "unknown"}
      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-2xs uppercase tracking-[0.08em] text-ink-muted hover:border-line-strong hover:text-ink"
    >
      <span aria-hidden="true" className="text-ink-subtle">
        {isCompact ? "▤" : "▥"}
      </span>
      {label}
    </button>
  );
}

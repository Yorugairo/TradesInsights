/**
 * Unit tests for the proof + layout primitives.
 *
 * These render through `renderToStaticMarkup` rather than a DOM testing
 * library. Every component here is a server component with no state, no
 * effects and no event handlers, so the static HTML IS the whole output —
 * jsdom and @testing-library would add two dependencies and test nothing extra.
 *
 * What is actually being defended: the unknown states. A meter that renders
 * "we never measured this" the same way it renders "we measured zero" is the
 * single most expensive class of bug in this product, and it is invisible to
 * typecheck, lint, and the e2e suite alike.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ConfidenceMeter, { confidenceState } from "./ConfidenceMeter.js";
import GateBadge, { gateBadgeState } from "./GateBadge.js";
import RangeBar, { rangeMarkerPercent } from "./RangeBar.js";
import ScoreBar, { scorePercent } from "./ScoreBar.js";
import SourceChip from "./SourceChip.js";
import StatTile from "./StatTile.js";
import EmptyState from "../ui/EmptyState.js";
import Table, { HeadTr, Td, Th, Tr } from "../ui/Table.js";

describe("rangeMarkerPercent", () => {
  test("places the marker proportionally within the span", () => {
    expect(rangeMarkerPercent(0, 25, 100)).toBe(25);
    expect(rangeMarkerPercent(100, 150, 200)).toBe(50);
  });

  test("centres the marker when low === high instead of producing NaN", () => {
    // A single-observation range is real. 0/0 would be NaN, which browsers drop
    // silently and render as "far left" — i.e. bottom of the range.
    const percent = rangeMarkerPercent(500, 500, 500);
    expect(Number.isNaN(percent)).toBe(false);
    expect(percent).toBe(50);
  });

  test("clamps a typical value outside the stated range", () => {
    expect(rangeMarkerPercent(10, 5, 20)).toBe(0);
    expect(rangeMarkerPercent(10, 99, 20)).toBe(100);
  });
});

describe("RangeBar", () => {
  test("degenerate range renders a real position, never NaN%", () => {
    const html = renderToStaticMarkup(
      <RangeBar low={500} typical={500} high={500} typicalLabel="$500" />,
    );
    expect(html).not.toContain("NaN");
    expect(html).toContain("left:50%");
  });

  test("generates an aria-label from the formatted labels", () => {
    const html = renderToStaticMarkup(
      <RangeBar low={1} typical={2} high={3} lowLabel="$1k" typicalLabel="$2k" highLabel="$3k" />,
    );
    expect(html).toContain('aria-label="Range from $1k to $3k, typically $2k"');
  });

  test("an explicit ariaLabel wins over the generated one", () => {
    const html = renderToStaticMarkup(
      <RangeBar low={1} typical={2} high={3} ariaLabel="Electrical bid window" />,
    );
    expect(html).toContain('aria-label="Electrical bid window"');
  });
});

describe("confidenceState", () => {
  test("null corroboration is unknown, not zero", () => {
    expect(confidenceState(null)).toEqual({ kind: "unknown" });
    expect(confidenceState(undefined)).toEqual({ kind: "unknown" });
  });

  test("a corroboration record with no sourceCount key is still unknown", () => {
    // The jsonb exists because some other pass wrote stageDepth. That says
    // nothing about how many sources were seen — an absent key is not a
    // measured zero.
    expect(confidenceState({ stageDepth: 2 })).toEqual({ kind: "unknown" });
  });

  test("reads the PRODUCTION jsonb shape, verbatim", () => {
    // This exact object is a row from `projects.corroboration` on 2026-07-27.
    // The regression it pins: the type previously named a `sources: string[]`
    // field the writer has never emitted, so every real record fell through the
    // unknown guard and 500 of 500 assessed rows rendered "Not assessed".
    const state = confidenceState({
      derivedAt: "2026-07-27T06:48:27Z",
      stageDepth: 1,
      sourceCount: 1,
      contradictions: [],
    });
    expect(state.kind).toBe("measured");
    expect(state).toMatchObject({ sourceCount: 1, stageDepth: 1, level: "single" });
  });

  test("a sourceCount of zero is a measurement, not unknown", () => {
    const state = confidenceState({ sourceCount: 0 });
    expect(state.kind).toBe("measured");
    expect(state).toMatchObject({ sourceCount: 0, level: "none" });
  });

  test("levels step at 1, 2 and 3 sources", () => {
    expect(confidenceState({ sourceCount: 1 })).toMatchObject({ level: "single" });
    expect(confidenceState({ sourceCount: 2 })).toMatchObject({ level: "corroborated" });
    expect(confidenceState({ sourceCount: 4 })).toMatchObject({
      level: "strong",
      sourceCount: 4,
    });
  });

  test("counts contradictions without resolving them", () => {
    const state = confidenceState({
      sourceCount: 2,
      contradictions: [{ field: "valuation", values: [1, 2], recordIds: ["r1", "r2"] }],
    });
    expect(state).toMatchObject({ contradictionCount: 1 });
  });
});

describe("ConfidenceMeter", () => {
  test("null renders the unknown state, not a zero bar", () => {
    const html = renderToStaticMarkup(<ConfidenceMeter corroboration={null} />);
    expect(html).toContain('data-confidence="unknown"');
    expect(html).toContain("Not assessed");
    expect(html).toContain("unknown, not zero");
    // No segment may be painted as filled.
    expect(html).not.toContain("bg-accent");
    // And the empty segments must be visually distinct from a measured zero.
    expect(html).toContain("border-dashed");
  });

  test("a measured zero is NOT the unknown state", () => {
    const html = renderToStaticMarkup(<ConfidenceMeter corroboration={{ sourceCount: 0 }} />);
    expect(html).toContain('data-confidence="none"');
    expect(html).toContain("No sources recorded");
    expect(html).not.toContain("Not assessed");
    expect(html).not.toContain("border-dashed");
  });

  test("a single-source production record renders as measured, not as unknown", () => {
    // The commonest real row. If this ever reads "Not assessed" again, the
    // corroboration type has drifted from the writer a second time.
    const html = renderToStaticMarkup(
      <ConfidenceMeter
        corroboration={{ sourceCount: 1, stageDepth: 1, contradictions: [], derivedAt: "2026-07-27T06:48:27Z" }}
      />,
    );
    expect(html).toContain('data-confidence="single"');
    expect(html).not.toContain("Not assessed");
    expect(html).toContain("1 independent source");
  });

  test("fills one segment per distinct source, capped at three", () => {
    const two = renderToStaticMarkup(<ConfidenceMeter corroboration={{ sourceCount: 2 }} />);
    expect(two.split("bg-accent").length - 1).toBe(2);
    expect(two).toContain("Corroborated");

    const many = renderToStaticMarkup(<ConfidenceMeter corroboration={{ sourceCount: 5 }} />);
    expect(many.split("bg-accent").length - 1).toBe(3);
    expect(many).toContain("5 independent sources");
  });

  test("surfaces contradictions as their own line", () => {
    const html = renderToStaticMarkup(
      <ConfidenceMeter
        corroboration={{
          sourceCount: 2,
          contradictions: [{ field: "units", values: [10, 12], recordIds: ["r1", "r2"] }],
        }}
      />,
    );
    expect(html).toContain("1 conflicting statement on record");
  });
});

describe("gateBadgeState", () => {
  test("an un-run gate is 'Not evaluated', not a failure", () => {
    expect(gateBadgeState(null)).toMatchObject({ label: "Not evaluated", tone: "unknown" });
    expect(gateBadgeState(undefined)).toMatchObject({ tone: "unknown" });
  });

  test("blocked_on_verifier is distinct from fail", () => {
    const blocked = gateBadgeState("blocked_on_verifier");
    const failed = gateBadgeState("fail");
    expect(blocked.label).not.toBe(failed.label);
    expect(blocked.tone).toBe("warn");
    expect(failed.tone).toBe("bad");
    expect(blocked.detail).toContain("not a failure");
  });

  test("pass is the only ok tone", () => {
    expect(gateBadgeState("pass")).toMatchObject({ label: "Publishable", tone: "ok" });
  });
});

describe("GateBadge", () => {
  test("null renders a dashed, colourless badge", () => {
    const html = renderToStaticMarkup(<GateBadge status={null} />);
    expect(html).toContain("Not evaluated");
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("text-ok");
    expect(html).not.toContain("text-bad");
  });

  test("pass does not render as dashed", () => {
    const html = renderToStaticMarkup(<GateBadge status="pass" />);
    expect(html).toContain("text-ok");
    expect(html).not.toContain("border-dashed");
  });
});

describe("StatTile", () => {
  test("a null value renders an em dash, never a zero", () => {
    const html = renderToStaticMarkup(<StatTile value={null} label="Projects" />);
    expect(html).toContain("—");
    expect(html).not.toContain(">0<");
  });

  test("a real zero still renders as zero", () => {
    // The mirror image of the rule above: a measured zero must survive.
    const html = renderToStaticMarkup(<StatTile value={0} label="Projects" />);
    expect(html).toContain(">0<");
    expect(html).not.toContain("—");
  });

  test("formats numbers with thousands separators", () => {
    const html = renderToStaticMarkup(<StatTile value={4121} label="Projects" />);
    expect(html).toContain("4,121");
  });
});

describe("SourceChip", () => {
  test("renders a link when given an href", () => {
    const html = renderToStaticMarkup(
      <SourceChip label="PALS" detail="2026-07-26" href="https://example.gov/permit/1" />,
    );
    expect(html).toContain('href="https://example.gov/permit/1"');
    expect(html).toContain("PALS");
    expect(html).toContain("2026-07-26");
  });

  test("renders a plain span when there is nothing to link to", () => {
    const html = renderToStaticMarkup(<SourceChip label="PALS" />);
    expect(html).not.toContain("<a ");
  });
});

describe("Table", () => {
  test("always renders a real tbody, because the e2e suite selects tbody tr", () => {
    const html = renderToStaticMarkup(
      <Table
        data-testid="demo-table"
        head={
          <HeadTr>
            <Th>County</Th>
            <Th numeric>Projects</Th>
          </HeadTr>
        }
      >
        <Tr>
          <Td>Pierce</Td>
          <Td numeric>12</Td>
        </Tr>
      </Table>,
    );
    expect(html).toContain('data-testid="demo-table"');
    expect(html).toContain("<tbody>");
    expect(html).toContain("<thead>");
    expect(html.indexOf("<tbody>")).toBeGreaterThan(html.indexOf("<thead>"));
  });
});

describe("EmptyState", () => {
  test("carries the reason it is empty, not just the fact", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        data-testid="no-rows"
        title="No opportunities match these filters."
        reason="Three sources covering this county have not run since Tuesday."
      />,
    );
    expect(html).toContain('data-testid="no-rows"');
    expect(html).toContain("have not run since Tuesday");
  });
});

describe("scorePercent", () => {
  test("maps the fixed 0-100 score scale onto the track", () => {
    expect(scorePercent(0)).toBe(0);
    expect(scorePercent(65)).toBe(65);
    expect(scorePercent(100)).toBe(100);
  });

  test("clamps rather than overflowing the track", () => {
    // The scorer clamps at 100, but a stored row predating that clamp must not
    // paint a bar wider than its container.
    expect(scorePercent(140)).toBe(100);
    expect(scorePercent(-5)).toBe(0);
  });
});

describe("ScoreBar", () => {
  test("an unscored opportunity renders dashed and empty, never a zero-width bar", () => {
    const html = renderToStaticMarkup(<ScoreBar score={null} />);
    expect(html).toContain('data-score="unscored"');
    expect(html).toContain("border-dashed");
    // No filled element at all — a 0% fill is how "not scored" becomes "scored 0".
    expect(html).not.toContain("width:0%");
    expect(html).toContain("scorer has not run");
  });

  test("draws the fill at the score and ticks at the account's own thresholds", () => {
    const html = renderToStaticMarkup(<ScoreBar score={72} priorityMin={85} digestMin={60} />);
    expect(html).toContain("width:72%");
    expect(html).toContain("left:60%");
    expect(html).toContain("left:85%");
    expect(html).toContain('data-score="72"');
  });

  test("states the thresholds in the accessible label, not just the picture", () => {
    const html = renderToStaticMarkup(<ScoreBar score={79} priorityMin={80} digestMin={65} />);
    expect(html).toContain("Score 79 of 100");
    expect(html).toContain("Priority review at 80");
  });
});

import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

/**
 * The calibration deck is also the intake form, which makes two things testable
 * that a normal deck never needs:
 *
 *  1. Navigation must not eat typing. `Deck` binds keydown on document and calls
 *     preventDefault() on Space and the arrows. Without an input guard, the
 *     customer types a company name and the deck jumps two slides — in front of
 *     him. That is the regression this file exists for.
 *  2. Slides CLIP rather than scroll (`.slide{overflow:hidden}`), so content that
 *     overflows is silently lost, not merely awkward. Fit is asserted at the 4K
 *     display it will be shown on AND at a laptop fallback.
 *
 * Loaded over file:// deliberately — that is how the artifact is opened in the
 * room, and it is the context where clipboard and ES modules behave differently.
 */
const DECK = pathToFileURL(
  path.resolve(__dirname, "../docs/meetings/2026-07-26-solis/presentation.html"),
).href;

const SIZES = [
  { name: "4K 32in", width: 3840, height: 2160 },
  { name: "laptop", width: 1440, height: 900 },
];

/**
 * BODY is the scroll container here, not html — the deck sets
 * `body{scroll-snap-type:y mandatory}` and the file's own comment explains that
 * putting it on html makes snapping silently inert.
 *
 * The trap: `window.scrollY` and `document.scrollingElement.scrollTop` both track
 * HTML, which never moves, so they read 0 forever. An earlier version of this file
 * used window.scrollY and every navigation assertion passed vacuously — 0 === 0 —
 * including the two guard tests whose whole purpose is to fail when nav is wrong.
 * Read document.body.scrollTop.
 */
const scrollTop = (page: Page) => page.evaluate(() => document.body.scrollTop);

async function slideIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll<HTMLElement>(".slide"));
    const y = document.body.scrollTop;
    let best = 0, bestD = Infinity;
    slides.forEach((s, i) => {
      const d = Math.abs(s.offsetTop - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  });
}

test.describe("calibration deck", () => {
  for (const size of SIZES) {
    test(`every slide fits at ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(DECK);
      await page.waitForFunction(() => document.querySelectorAll(".slide-no").length > 0);

      // .slide-content has overflow:hidden — anything taller is CUT OFF on screen.
      const overflowing = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".slide-content"))
          .map((el, i) => ({ i, over: el.scrollHeight - el.clientHeight }))
          .filter((r) => r.over > 2),
      );
      expect(overflowing, `clipped slides: ${JSON.stringify(overflowing)}`).toEqual([]);
    });
  }

  test("the wide measure actually uses the 4K width", async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.goto(DECK);
    const widths = await page.evaluate(() => {
      const wide = document.querySelector<HTMLElement>(".slide.wide .slide-content");
      const narrow = document.querySelector<HTMLElement>(".slide:not(.wide) .slide-content");
      return { wide: wide?.clientWidth ?? 0, narrow: narrow?.clientWidth ?? 0 };
    });
    // Wide slides open up; prose slides stay at the readable measure on purpose.
    expect(widths.wide).toBeGreaterThan(1600);
    expect(widths.narrow).toBeLessThanOrEqual(1260);
  });

  test.describe("nav must not eat typing", () => {
    test("Space types a space instead of advancing", async ({ page }) => {
      await page.goto(DECK);
      const field = page.locator("textarea[data-fix]").first();
      await field.scrollIntoViewIfNeeded();
      const before = await slideIndex(page);

      await field.click();
      await page.keyboard.type("Baker");
      await page.keyboard.press("Space");
      await page.keyboard.type("Construction");

      await expect(field).toHaveValue("Baker Construction");
      expect(await slideIndex(page)).toBe(before);
    });

    test("arrow keys move the caret, not the deck", async ({ page }) => {
      await page.goto(DECK);
      const field = page.locator("textarea[data-fix]").first();
      await field.scrollIntoViewIfNeeded();
      const before = await slideIndex(page);

      await field.click();
      await page.keyboard.type("abc");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.type("X");

      await expect(field).toHaveValue("abXc");
      expect(await slideIndex(page)).toBe(before);
    });

    test("but arrows still navigate outside a field", async ({ page }) => {
      await page.goto(DECK);
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      const before = await scrollTop(page);
      await page.keyboard.press("ArrowDown");
      // Assert on scroll position, not a derived index: smooth-scroll means the
      // index settles later than the gesture, and a flaky nav test gets deleted
      // rather than fixed — taking the two guard tests above with it.
      await page.waitForFunction((y) => document.body.scrollTop > y + 50, before, { timeout: 4000 });
      expect(await scrollTop(page)).toBeGreaterThan(before);
    });
  });

  test("answers persist across a reload", async ({ page }) => {
    await page.goto(DECK);
    const field = page.locator("textarea[data-fix]").first();
    await field.scrollIntoViewIfNeeded();
    await field.click();
    await page.keyboard.type("keep me");
    await page.waitForTimeout(150);

    await page.reload();
    await expect(page.locator("textarea[data-fix]").first()).toHaveValue("keep me");
  });

  test("the store key is the one answers may already live under", async ({ page }) => {
    await page.goto(DECK);
    // Renaming this key silently orphans answers already captured. Pin it.
    expect(await page.evaluate(() => window.CALIBRATION.STORE)).toBe("solis-intake-2026-07-26");
  });

  /**
   * The books A–D matrix was silently deleted when sections 2–3 were converted to
   * the shared model: the rewrite replaced a range of markup and this question was
   * inside it. Nothing failed — the deck still rendered, the form still saved, and
   * the single most strategic question in the session had simply stopped existing.
   * Pin all eight keys.
   */
  test("the books A–D matrix survives, with its original keys", async ({ page }) => {
    await page.goto(DECK);
    const keys = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-k^='book_']")).map((el) => el.getAttribute("data-k")).sort(),
    );
    expect(keys).toEqual([
      "book_a_rank", "book_a_share", "book_b_rank", "book_b_share",
      "book_c_rank", "book_c_share", "book_d_rank", "book_d_share",
    ]);
  });

  /**
   * Pill answers exported from the DECK, not just the intake.
   *
   * collect() was lifted from intake.html without its `.pills[data-group]` branch,
   * so every radio answer typed into the deck was dropped from the export — and
   * the loss was invisible, because isAnswered() counts a checked radio. The
   * progress figure said the question was answered while the JSON did not contain
   * it. That is worse than an obvious failure: the operator gets confirmation on
   * screen and discovers the gap only when applying the config diff, days later.
   *
   * Assert the whole round trip — answer, export, reload, still answered.
   */
  test("a pill answer survives export and reload on the deck", async ({ page }) => {
    // Pin a viewport the deck actually targets. At the runner's small default the
    // three-card ask column packs tight enough that a neighbour wins the hit test;
    // this deck is built for 4K with 1440x900 as its declared laptop fallback, and
    // both are asserted to fit by the viewport tests above.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DECK);
    // The deck scrolls smoothly, so an element's box keeps moving after
    // scrollIntoView() returns. Kill the animation rather than forcing the click —
    // a forced click would also pass if the control were genuinely unreachable.
    await page.addStyleTag({ content: "*{scroll-behavior:auto !important}" });

    const pill = page.locator(".ask .pills[data-group]").first();
    await pill.scrollIntoViewIfNeeded();
    const group = await pill.getAttribute("data-group");
    const radio = pill.locator("input[type=radio]").first();
    const value = await radio.getAttribute("value");

    await radio.check();
    await page.waitForTimeout(150);

    const exported = await page.evaluate(
      (g) => JSON.parse(localStorage.getItem("solis-intake-2026-07-26") || "{}").answers?.[g],
      group,
    );
    expect(exported, `pill "${group}" was answered but never reached the export`).toBe(value);

    await page.reload();
    await expect(
      page.locator(`.pills[data-group="${group}"] input[value="${value}"]`),
    ).toBeChecked();
  });

  test("every question in the model reaches the deck", async ({ page }) => {
    await page.goto(DECK);
    // Guards the same class of loss generally: a question defined but never mounted
    // because no slide claimed it and no generated slide picked it up.
    const missing = await page.evaluate(() => {
      const ids = window.CALIBRATION.QUESTIONS.map((q) => q.id);
      const mounted = new Set(
        Array.from(document.querySelectorAll("[data-question]")).map((el) => el.getAttribute("data-question")),
      );
      return ids.filter((id) => !mounted.has(id));
    });
    expect(missing, `questions defined but never rendered: ${missing.join(", ")}`).toEqual([]);
  });

  test("progress counts cards, not fields", async ({ page }) => {
    await page.goto(DECK);
    const total = await page.locator("#total").textContent();
    const cards = await page.evaluate(() => document.querySelectorAll(".q").length);
    expect(Number(total)).toBe(cards);

    // One card, two fields touched — must count as one answered, not two.
    const before = Number(await page.locator("#answered").textContent());
    const panel = page.locator(".ask[data-assumption]").first();
    await panel.locator("input[type=radio]").first().check();
    await panel.locator("textarea").fill("something");
    await page.waitForTimeout(120);
    expect(Number(await page.locator("#answered").textContent())).toBe(before + 1);
  });
});

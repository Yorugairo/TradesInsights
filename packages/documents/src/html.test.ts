import { describe, expect, it } from "vitest";
import { absoluteUrl, collapsedText, extractLinks, loadHtml } from "./html.js";

const PAGE = `
<html><body>
  <div id="a">  Hello
     world </div>
  <ul id="links">
    <li><a href="/docs/plan.pdf">  Site   Plan </a></li>
    <li><a href="https://other.example/x">Other</a></li>
    <li><a href="javascript:void(0)">JS</a></li>
    <li><a href="mailto:x@example.com">Mail</a></li>
    <li><a href="">Empty</a></li>
  </ul>
</body></html>`;

describe("html extraction", () => {
  it("collapses whitespace in element text", () => {
    const $ = loadHtml(PAGE);
    expect(collapsedText($("#a"))).toBe("Hello world");
  });

  it("resolves relative URLs against the page URL", () => {
    expect(absoluteUrl("/docs/plan.pdf", "https://example.gov/page/")).toBe(
      "https://example.gov/docs/plan.pdf",
    );
    expect(absoluteUrl("sub.html", "https://example.gov/dir/page.html")).toBe(
      "https://example.gov/dir/sub.html",
    );
  });

  it("rejects empty, javascript:, and mailto: hrefs", () => {
    expect(absoluteUrl("", "https://example.gov/")).toBeNull();
    expect(absoluteUrl("javascript:void(0)", "https://example.gov/")).toBeNull();
    expect(absoluteUrl("mailto:x@example.com", "https://example.gov/")).toBeNull();
    expect(absoluteUrl(undefined, "https://example.gov/")).toBeNull();
  });

  it("extracts only real links with collapsed text", () => {
    const $ = loadHtml(PAGE);
    const links = extractLinks($, $("#links"), "https://example.gov/page/");
    expect(links).toEqual([
      { url: "https://example.gov/docs/plan.pdf", text: "Site Plan" },
      { url: "https://other.example/x", text: "Other" },
    ]);
  });

  it("accepts Buffer input", () => {
    const $ = loadHtml(Buffer.from("<p>ok</p>", "utf8"));
    expect(collapsedText($("p"))).toBe("ok");
  });
});

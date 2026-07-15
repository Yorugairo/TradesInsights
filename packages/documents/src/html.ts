import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

export type { CheerioAPI };

/** Parse an HTML document for structural extraction. */
export function loadHtml(html: string | Buffer): CheerioAPI {
  return cheerio.load(html.toString("utf8"));
}

/** Decode HTML entities in a text fragment (WP REST titles etc.), collapse whitespace. */
export function decodeHtmlEntities(fragment: string): string {
  return cheerio
    .load(`<x>${fragment}</x>`)("x")
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

/** Element text with whitespace collapsed to single spaces, trimmed. */
export function collapsedText(el: Cheerio<AnyNode>): string {
  return el.text().replace(/\s+/g, " ").trim();
}

/** Resolve a possibly-relative href against the page URL. Returns null for empty/js/mailto. */
export function absoluteUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("javascript:") || trimmed.startsWith("mailto:")) {
    return null;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

export interface ExtractedLink {
  url: string;
  text: string;
}

/** All resolved links inside an element, with collapsed link text. */
export function extractLinks(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  baseUrl: string,
): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  scope.find("a[href]").each((_i, a) => {
    const el = $(a);
    const url = absoluteUrl(el.attr("href"), baseUrl);
    if (url) out.push({ url, text: collapsedText(el) });
  });
  return out;
}

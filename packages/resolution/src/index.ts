// Address, organization, and project matching (spec §10).
// M2.1: normalizers. M2.2: resolver passes 1–3 + persistence.
export * from "./normalize.js";
export * from "./resolver.js";
export * from "./fuzzy.js";
export * from "./developments.js";
export * from "./review.js";
export * from "./velocity.js";
export * from "./geocode.js";
export * from "./identifiers.js";
export * from "./registry-link.js";
export * from "./registry-observations.js";
export * from "./google-place-review.js";
export * from "./registry-identifiers.js";
// Corporate-family tier: principal ↔ person discovery. Deliberately NOT part of
// the name-match index — see the module header.
export * from "./principal-person.js";
export * from "./google-place-scrape.js";
export * from "./google-place-contested.js";
export * from "./google-place-rescore.js";
// Entity↔entity field agreement — "what links these two companies besides the
// name?". Distinct from corroboration.js, which cross-references SOURCES for one
// PROJECT.
export * from "./entity-corroboration.js";
export * from "./trade-taxonomy.js";
export * from "./corroboration.js";
export * from "./project-trades.js";

// Digest and email rendering (spec §18). M3.6: idempotent weekly digest.
export * from "./digest.js";
export * from "./render.js";
export * from "./deliver.js";
export * from "./metrics.js";
export * from "./alerts.js";
export * from "./roi.js";
export * from "./leadtime.js";
export * from "./pipeline.js";
export * from "./actions.js";
export * from "./field-notify.js";
// WS-D: connector-agnostic CRM sync (CSV download + outbound webhook).
export * from "./export.js";

#!/usr/bin/env node
"use strict";
/**
 * SessionStart hook — inject accumulated project learnings.
 *
 * Reads .claude/learned/LEARNED.md and injects it as additionalContext so
 * durable lessons from prior sessions surface at the start of each new one.
 * Half of the project-scoped "self-learning loop" (see docs/operations.md).
 *
 * Fails open: any error → no output, exit 0, never disrupts session start.
 * No per-tool-call capture; reads only the curated LEARNED.md.
 */
const fs = require("fs");
const path = require("path");

const MAX_CHARS = 6000; // cap injected context

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

try {
  // Drain stdin (SessionStart event JSON) — not needed, but read to be tidy.
  try {
    fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }

  const file = path.join(projectDir(), ".claude", "learned", "LEARNED.md");
  if (!fs.existsSync(file)) process.exit(0);

  let content = fs.readFileSync(file, "utf8");
  // Skip if the file has only the header / no real bullets.
  const hasLessons = /^\s*[-*] /m.test(content);
  if (!hasLessons) process.exit(0);

  if (content.length > MAX_CHARS) {
    content = content.slice(0, MAX_CHARS) + "\n… (truncated; see .claude/learned/LEARNED.md)";
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        "Accumulated project learnings (from prior sessions, .claude/learned/LEARNED.md):\n\n" +
        content,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch {
  process.exit(0);
}

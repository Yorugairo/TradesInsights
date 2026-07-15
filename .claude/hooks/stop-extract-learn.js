#!/usr/bin/env node
"use strict";
/**
 * Stop hook — extract a durable lesson at session end (once per session).
 *
 * The other half of the project-scoped self-learning loop. On stop, for a
 * substantive session, asks the model (exactly once) to append one concise,
 * reusable lesson to .claude/learned/LEARNED.md — explicitly allowing a no-op
 * when nothing durable was learned. SessionStart then injects those lessons
 * back next time.
 *
 * Design constraints (per the chosen "custom minimal auto-loop, no per-call
 * capture" scope):
 *   - No per-tool-call capture; reads only the transcript at session end.
 *   - Loop-safe: honors stop_hook_active and a per-session marker so it nudges
 *     at most once per session and never loops.
 *   - Fails open: any error → allow stop (exit 0), never wedges a session.
 *   - Project-scoped: store + state live under .claude/learned/.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIN_USER_MESSAGES = 8; // skip trivial/short sessions

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function countUserMessages(transcriptPath) {
  try {
    const data = fs.readFileSync(transcriptPath, "utf8");
    const m = data.match(/"type"\s*:\s*"user"/g);
    return m ? m.length : 0;
  } catch {
    return 0;
  }
}

try {
  const input = JSON.parse(readStdin() || "{}");

  // If we already blocked once and the agent is continuing, allow the stop now.
  if (input.stop_hook_active) process.exit(0);

  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

  const learnedDir = path.join(projectDir(), ".claude", "learned");
  const stateDir = path.join(learnedDir, ".state");
  const sessionId =
    input.session_id ||
    crypto.createHash("sha256").update(String(transcriptPath)).digest("hex").slice(0, 16);
  const marker = path.join(stateDir, `${sessionId}.done`);

  // Only nudge once per session.
  if (fs.existsSync(marker)) process.exit(0);

  if (countUserMessages(transcriptPath) < MIN_USER_MESSAGES) process.exit(0);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString());

  const reason =
    "Session-end learning (project self-learning loop). If this session produced a " +
    "durable, reusable lesson for THIS repository — a non-obvious gotcha, a fix pattern, " +
    "a discovered project convention, or a correction worth remembering — append ONE " +
    "concise bullet to .claude/learned/LEARNED.md under a dated heading (create the file " +
    "with a top-level title if missing). Keep it specific and general-purpose; do not " +
    "record secrets, one-off details, or anything already in LEARNED.md. If nothing " +
    "durable was learned, or it is already recorded, do NOT write anything — just stop.";

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
} catch {
  process.exit(0);
}

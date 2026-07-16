/**
 * S3 (strengthening addendum §6) — deterministic bid-invitation email parser.
 * Parses a customer-forwarded `.eml` (or raw message) into structured invitation
 * fields. Purely deterministic (headers + body regex); anything not clearly
 * present is `null` — never guessed (governing rule). No model call.
 */

export interface ParsedInvitationEmail {
  messageId: string | null;
  sender: string | null;
  recipients: string[];
  subject: string | null;
  sentAt: Date | null;
  projectName: string | null;
  addressRaw: string | null;
  gcName: string | null;
  estimatorName: string | null;
  estimatorEmail: string | null;
  bidDueAt: Date | null;
  jobWalkAt: Date | null;
  scopeSummary: string | null;
  addendumNumber: number | null;
  prevailingWage: boolean;
  /** True only when the body carries an explicit solicitation/invitation phrase. */
  explicitInvitation: boolean;
  bodyText: string;
}

const EXPLICIT_INVITATION =
  /\b(invitation to bid|invite you to bid|bid invitation|request for (?:proposal|quote|bid)|solicitation|you are invited to submit|please submit (?:your )?(?:bid|proposal))\b/i;

function headerBlock(raw: string): { headers: Map<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headerText = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);
  const headers = new Map<string, string>();
  // Unfold continued header lines (leading whitespace) then key: value.
  const unfolded = headerText.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return { headers, body };
}

function firstEmail(s: string | undefined): string | null {
  if (!s) return null;
  const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(s);
  return m ? m[0] : null;
}

function nameFromAddress(s: string | undefined): string | null {
  if (!s) return null;
  const named = /^\s*"?([^"<@]+?)"?\s*</.exec(s);
  if (named && named[1]!.trim()) return named[1]!.trim();
  return null;
}

/** Parse a date string to a Date, or null if it is not a recognizable date. */
function safeDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

function bodyMatch(body: string, re: RegExp): string | null {
  const m = re.exec(body);
  return m && m[1] ? m[1].trim() : null;
}

export function parseInvitationEmail(raw: string): ParsedInvitationEmail {
  const { headers, body } = headerBlock(raw);
  const recipients = [headers.get("to"), headers.get("cc")]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const dueRaw = bodyMatch(body, /(?:bids?\s+due|bid\s+due\s+date|due\s+date|proposals?\s+due)[:\s]+([^\n]+)/i);
  const walkRaw = bodyMatch(body, /(?:job\s*walk|pre-?bid(?:\s+meeting)?|site\s+visit|walk-?through)[:\s]+([^\n]+)/i);
  const addendum = /addendum\s*(?:no\.?|number|#)?\s*(\d+)/i.exec(body);

  return {
    messageId: headers.get("message-id") ?? null,
    sender: headers.get("from") ?? null,
    recipients,
    subject: headers.get("subject") ?? null,
    sentAt: safeDate(headers.get("date")),
    projectName: bodyMatch(body, /project(?:\s+name)?[:\s]+([^\n]+)/i),
    addressRaw: bodyMatch(body, /(?:project\s+address|address|location)[:\s]+([^\n]+)/i),
    gcName: bodyMatch(body, /(?:general\s+contractor|gc|from|company)[:\s]+([^\n]+)/i) ?? nameFromAddress(headers.get("from")),
    estimatorName: bodyMatch(body, /(?:estimator|contact|pm|project\s+manager)[:\s]+([A-Za-z .,'-]+)/i),
    estimatorEmail: firstEmail(bodyMatch(body, /(?:estimator|contact)[^\n]*/i) ?? undefined) ?? firstEmail(headers.get("from")),
    bidDueAt: safeDate(dueRaw),
    jobWalkAt: safeDate(walkRaw),
    scopeSummary:
      bodyMatch(body, /(?:scope(?:\s+of\s+work)?|trade|division)[:\s]+([^\n]+)/i) ??
      (/(division\s*0?9|drywall|painting|gypsum)/i.test(body) ? "interior finishes (detected)" : null),
    addendumNumber: addendum ? Number(addendum[1]) : null,
    prevailingWage: /\b(prevailing\s+wage|davis-?bacon|public\s+works?|certified\s+payroll)\b/i.test(body),
    explicitInvitation: EXPLICIT_INVITATION.test(body) || EXPLICIT_INVITATION.test(headers.get("subject") ?? ""),
    bodyText: body,
  };
}

import { describe, expect, it } from "vitest";
import { parseInvitationEmail } from "./email.js";

const EML = `From: "Acme Builders" <estimating@acme-gc.com>
To: bids@solis.example
Subject: Invitation to Bid - Lakewood Medical TI
Date: Mon, 20 Jul 2026 09:00:00 -0700
Message-ID: <inv-123@acme-gc.com>

You are invited to submit a bid for the following project.

Project: Lakewood Medical Office TI
Address: 1200 Bridgeport Way, Lakewood WA
Scope: Division 09 - drywall and painting
Estimator: Dana Lee estimating@acme-gc.com
Bids due: July 30, 2026 2:00 PM
Job walk: July 24, 2026 10:00 AM
Addendum No. 2 attached.
This is a public works project subject to prevailing wage.
`;

describe("S3 parseInvitationEmail (deterministic)", () => {
  it("extracts headers, dates, GC/estimator, scope, addendum, prevailing wage", () => {
    const p = parseInvitationEmail(EML);
    expect(p.messageId).toBe("<inv-123@acme-gc.com>");
    expect(p.subject).toContain("Invitation to Bid");
    expect(p.projectName).toBe("Lakewood Medical Office TI");
    expect(p.addressRaw).toContain("Bridgeport Way");
    expect(p.estimatorEmail).toBe("estimating@acme-gc.com");
    expect(p.scopeSummary?.toLowerCase()).toContain("drywall");
    expect(p.addendumNumber).toBe(2);
    expect(p.prevailingWage).toBe(true);
    expect(p.explicitInvitation).toBe(true);
    expect(p.bidDueAt?.getUTCFullYear()).toBe(2026);
    expect(p.jobWalkAt).not.toBeNull();
  });

  it("does not fabricate: absent fields are null, non-invitations are flagged", () => {
    const plain = parseInvitationEmail(
      "From: x@y.com\nSubject: lunch?\nDate: bogus\n\nWant to grab lunch?",
    );
    expect(plain.projectName).toBeNull();
    expect(plain.bidDueAt).toBeNull();
    expect(plain.sentAt).toBeNull(); // unparseable date → null, not a guess
    expect(plain.explicitInvitation).toBe(false);
    expect(plain.prevailingWage).toBe(false);
  });
});

import { NextResponse } from "next/server";
import { exportPursuits } from "@otn/delivery";
import { withAccount } from "../../../../../lib/api.js";

// GET /api/app/pursuits/export?format=csv|json
//
// Account-scoped CRM export DOWNLOAD (a pull, not a push): `?format=csv` streams
// the CSV as a browser attachment; default/`json` returns the HubSpot/Zapier
// payload. Scoped by `account.id` (never a request param) — an account can only
// ever download its OWN opportunities. This surface never triggers the outbound
// webhook (that push is the CLI/scheduled path), so exportPursuits runs with no
// webhookUrl and reports webhookStatus "skipped".
export const GET = withAccount(async ({ db, account, req }) => {
  const format = new URL(req.url).searchParams.get("format") ?? "json";
  const result = await exportPursuits(db, account.id, {});
  if (format === "csv") {
    const filename = `pursuits-${account.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new NextResponse(result.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  }
  return NextResponse.json(result.payload);
});

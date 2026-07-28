import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  DISPOSITION_REASONS,
  accountBidWindows,
  bidTrackFor,
  buildDecisionMemo,
  classify,
  type BidWindowStatus,
  type ProjectFeatures,
} from "@otn/intelligence";
import ConfidenceMeter from "../../../../components/proof/ConfidenceMeter.js";
import GateBadge from "../../../../components/proof/GateBadge.js";
import SourceChip from "../../../../components/proof/SourceChip.js";
import Card, { CardBody, CardFooter, CardHeader } from "../../../../components/ui/Card.js";
import PageHeader from "../../../../components/ui/PageHeader.js";
import Panel from "../../../../components/ui/Panel.js";
import Table, { HeadTr, Td, Th, Tr } from "../../../../components/ui/Table.js";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { bandLabel, bandTone, formatScore, routeLabel, stageLabel } from "../../../../lib/format.js";
import { accountByKey, campusSiblings, opportunityDetail } from "../../../../lib/queries.js";
import { Badge, fmtDate, fmtMoney } from "../../../../lib/ui.js";
import { FeedbackForm, StartPursuitButton, StateButtons } from "./actions.js";

const CAPACITY_TONE: Record<string, "green" | "amber" | "red"> = {
  likely_fit: "green",
  possible_stretch: "amber",
  likely_too_large: "amber",
  excluded: "red",
  unknown: "amber",
};

const BID_WINDOW_TONE: Record<BidWindowStatus, "green" | "amber" | "red" | "gray"> = {
  confirmed_open: "green",
  open: "green",
  opens_soon: "amber",
  likely_closed: "red",
  watch: "gray",
};

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const o = await opportunityDetail(db(), id, account.id);
  if (!o) notFound();

  // Sequential, not `Promise.all` — the production pool max is 2 and this page
  // already holds one connection per read. See the note in the list page.
  const memo = await buildDecisionMemo(db(), id);
  const campus = await campusSiblings(db(), o.project.id, o.project.campusBlock);

  // Wave 2 E1 — the Bid Clock. TRADE-SCOPED: windows exist only for the
  // account's capabilities that carry a stated timing model (drywall/painting
  // → interior-finish); an unmodeled trade renders NOTHING here, never a
  // borrowed clock. Same classify → track → window chain the digest/export use.
  const capabilities = Array.isArray(account.capabilities) ? account.capabilities : [];
  const bidCls = classify({
    projectId: o.project.id,
    county: o.project.county,
    permittingJurisdiction: o.project.permittingJurisdiction,
    city: o.project.city,
    stage: o.project.stage,
    text: o.project.bidText,
    maxUnits: o.project.maxUnits,
    maxValuation: o.project.maxValuation,
    clusterSize: 0,
    hasVelocitySignal: false,
    orgs: [],
    aGradeEvidence: 0,
    lastMaterialChangeAt: null,
  } satisfies ProjectFeatures);
  const bidTrack = bidTrackFor(bidCls);
  const bidWindows = accountBidWindows(capabilities, {
    stage: o.project.stage,
    track: bidTrack,
    issuedAt: o.project.latestIssueDate ? new Date(o.project.latestIssueDate) : null,
  });

  const rationale = o.rationale as {
    components?: Record<string, number>;
    signals?: string[];
  } | null;

  return (
    <main>
      <PageHeader
        title={o.project.name}
        titleTestId="opportunity-title"
        description={
          <>
            {o.project.address ?? "Address not recorded"} · Units {o.project.maxUnits ?? "—"} ·
            Valuation {fmtMoney(o.project.maxValuation)}
            {Array.isArray(o.project.parcels) && o.project.parcels.length > 0
              ? ` · Parcels ${(o.project.parcels as string[]).join(", ")}`
              : ""}
          </>
        }
        action={
          <Link
            href={`/app/projects/${o.project.id}`}
            className="inline-flex items-center rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-sm font-semibold text-ink"
          >
            Project record →
          </Link>
        }
        meta={
          <>
            <Badge>{o.project.county}</Badge>
            <Badge>{o.project.permittingJurisdiction}</Badge>
            <Badge>{stageLabel(o.project.stage)}</Badge>
            <Badge tone={bandTone(o.state)}>{bandLabel(o.state)}</Badge>
            <GateBadge status={o.gate?.status as never} />
            <span className="text-xs text-ink-muted">
              score <strong className="tabular-nums text-ink">{formatScore(o.score)}</strong> ·
              route {routeLabel(o.route)} · last material change{" "}
              {fmtDate(o.project.lastMaterialChangeAt)}
            </span>
          </>
        }
      />

      {/*
        The next action leads the page. It used to sit below the memo, five
        sections down — TASTE-insights Core Move 2 is "one screen, one next
        action", and an action the operator has to scroll to find is not one.
        `recommendNextAction` (queries.ts) derives it from stored gate and
        extraction state, so it is a read of the pipeline, not advice.
      */}
      <Card tone="gold" className="mb-[calc(var(--stack)*1.5)]">
        <CardBody>
          <div className="text-2xs uppercase tracking-[0.08em] text-ink-muted">
            Recommended next action
          </div>
          <p data-testid="next-action" className="mt-1 text-lg font-semibold text-accent-ink">
            {o.nextAction}
          </p>
        </CardBody>
      </Card>

      {bidWindows.length > 0 && (
        <Card data-testid="bid-clock" className="mb-[calc(var(--stack)*1.5)]">
          <CardHeader
            title="Bid clock"
            detail={`${bidTrack} track`}
            action={<Badge tone="gray">{bidTrack}</Badge>}
          />
          <CardBody className="flex flex-col gap-2">
            {bidWindows.map((w) => (
              <p key={w.trade} data-testid={`bid-window-${w.trade}`} className="text-sm text-ink">
                <strong className="capitalize">{w.trade}</strong>{" "}
                <Badge tone={BID_WINDOW_TONE[w.status]}>{w.status.replace(/_/g, " ")}</Badge>{" "}
                {w.note}
              </p>
            ))}
          </CardBody>
          <CardFooter>
            Typical-sequencing inference for your trades only — never a promise. A stated bid
            solicitation on record always overrides this model.
          </CardFooter>
        </Card>
      )}

      {o.brief && (
        <Card data-testid="decision-brief" className="mb-[calc(var(--stack)*1.5)]">
          <CardHeader
            title="The brief"
            action={
              <Badge tone={memo?.verifierStatus === "passed" ? "green" : "amber"}>
                verified{memo?.verifierStatus === "passed" ? "" : " — pending gate"}
              </Badge>
            }
          />
          <CardBody>
            <p data-testid="brief-narrative" className="text-base leading-relaxed text-ink">
              {o.brief.segments.map((s, i) =>
                s.kind === "inference" ? (
                  // An inference inside prose is the easiest place for the
                  // distinction to be lost, so it gets three independent
                  // signals: colour, italics, and a dotted underline that
                  // survives both registers and greyscale printing.
                  <span
                    key={i}
                    className="italic text-ink-muted underline decoration-dotted decoration-warn underline-offset-4"
                    title="Labelled inference — not a confirmed fact"
                  >
                    {s.text}{" "}
                  </span>
                ) : (
                  <span key={i}>{s.text} </span>
                ),
              )}
            </p>
          </CardBody>
          <CardFooter>
            Composed from verified facts only — every sentence traces to the evidence below;
            italics are labeled inferences, not confirmed facts.
          </CardFooter>
        </Card>
      )}

      {memo && (
        <Card data-testid="decision-memo" className="mb-[calc(var(--stack)*1.5)]">
          <CardHeader title="Decision memo" detail={memo.whatChanged} />
          <CardBody className="flex flex-col gap-3">
            <p data-testid="memo-recommended-action" className="text-sm text-ink">
              <strong>Recommended action:</strong> {memo.recommendedAction}
            </p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <span className="text-ink-muted">
                score <strong className="tabular-nums text-ink">{formatScore(memo.score)}</strong> ·
                route {routeLabel(memo.route)}
              </span>
              <Badge>procurement: {memo.procurementState}</Badge>
              <Badge tone={CAPACITY_TONE[memo.capacityAssessment] ?? "amber"}>
                capacity: {memo.capacityAssessment}
              </Badge>
              <Badge
                tone={
                  memo.verifierStatus === "passed"
                    ? "green"
                    : memo.verifierStatus === "failed"
                      ? "red"
                      : "amber"
                }
              >
                verifier: {memo.verifierStatus}
              </Badge>
            </p>
            {memo.capacityExplanation && (
              <p data-testid="memo-capacity" className="text-sm text-ink">
                <strong>Capacity note:</strong> {memo.capacityExplanation}
              </p>
            )}
            <p className="text-sm text-ink">
              <strong>Timing:</strong> {memo.timingAssessment}
            </p>
            {memo.talkingPoints.length > 0 && (
              <div data-testid="talking-points">
                <strong className="text-sm text-ink">
                  Outreach prep (evidence-only — for your own call/text):
                </strong>
                <ul className="mt-1 list-disc pl-5 text-sm text-ink">
                  {memo.talkingPoints.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {campus && (
        <Card data-testid="campus-panel" className="mb-[calc(var(--stack)*1.5)]">
          <CardHeader
            title="Active campus"
            detail={`One site, one relationship — ${campus.siblings.length + 1} active projects on this parcel block.`}
            action={<Badge tone="green">block {campus.block}</Badge>}
          />
          <CardBody>
            <ul className="list-disc pl-5 text-sm text-ink">
              {campus.siblings.map((s) => (
                <li key={s.id}>
                  <Link href={`/app/projects/${s.id}`} className="underline">
                    {s.name}
                  </Link>{" "}
                  — {stageLabel(s.stage)}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {o.corroboration && (
        <Card data-testid="corroboration-panel" className="mb-[calc(var(--stack)*1.5)]">
          <CardHeader
            title="Corroboration"
            detail="How many independent public publishers describe this project."
          />
          <CardBody className="flex flex-col gap-3">
            {/*
              Reads `sourceCount`, the field the corroboration pass actually
              writes (packages/resolution/src/corroboration.ts:96-100). This
              block previously read a `sources: string[]` that no writer has ever
              emitted, so the `>= 2` branch was unreachable and every project —
              including multi-source ones — rendered "Single public source so
              far". The count is all the writer stores, so the count is all we
              claim; naming the publishers would need a list this jsonb does not
              carry.
            */}
            <ConfidenceMeter corroboration={o.corroboration} />
            {typeof o.corroboration.stageDepth === "number" && o.corroboration.stageDepth > 0 && (
              <p className="text-sm text-ink-muted">
                Lifecycle confirmed through {o.corroboration.stageDepth} distinct stage
                {o.corroboration.stageDepth === 1 ? "" : "s"}.
              </p>
            )}
            {(o.corroboration.contradictions?.length ?? 0) > 0 && (
              <div data-testid="corroboration-contradictions">
                <strong className="text-sm text-bad">
                  Conflicting statements on record (both values shown — never resolved for you):
                </strong>
                <ul className="mt-1 list-disc pl-5 text-sm text-ink">
                  {o.corroboration.contradictions!.map((c, i) => (
                    <li key={i}>
                      <code className="text-ink-muted">{c.field}</code> stated as{" "}
                      {c.values.map((v) => JSON.stringify(v)).join(" and ")} by different records
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* EXACT HEADING — asserted by text at app.spec.ts:70. Do not reword. */}
      <Panel
        title="Confirmed facts vs. inferences"
        detail={
          o.extraction
            ? "Two treatments, deliberately unalike: a fact is cited, an inference is reasoned. Nothing on the right has been confirmed."
            : // Describing a two-column contrast that is not on screen would be
              // a caption for a picture that is not there.
              "No extraction has run for this opportunity, so there is nothing to contrast yet."
        }
      >
        {o.extraction ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader
                title="Facts"
                detail="Confirmed and evidence-cited"
                action={<Badge tone="green">{o.extraction.facts.length}</Badge>}
              />
              <CardBody>
                <ul className="flex flex-col gap-2 text-sm">
                  {o.extraction.facts.map((f, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2">
                      <code className="text-ink-muted">{f.path}</code>
                      <span className="font-semibold text-ink">{JSON.stringify(f.value)}</span>
                      <Badge tone="green">confidence {f.confidence}</Badge>
                    </li>
                  ))}
                  {o.extraction.facts.length === 0 && (
                    <li className="text-ink-muted">None extracted.</li>
                  )}
                </ul>
              </CardBody>
            </Card>

            {/*
              The inference column is dashed, italic and muted — never the solid
              bordered surface the facts get. The gate already rejects
              unsubstantiated claims server-side; the job here is to not undo
              that visually. If these two columns ever look alike, the page is
              wrong even when every value in it is right.
            */}
            <div className="rounded-lg border border-dashed border-line-strong">
              <div className="flex items-start justify-between gap-3 border-b border-dashed border-line px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-ink-muted">Inferences</div>
                  <div className="mt-0.5 text-xs text-ink-subtle">
                    Reasoned, not confirmed — never treat as fact
                  </div>
                </div>
                <Badge tone="amber">{o.extraction.inferences.length}</Badge>
              </div>
              <div className="px-4 py-[var(--stack)]">
                <ul className="flex flex-col gap-2 text-sm">
                  {o.extraction.inferences.map((inf, i) => (
                    <li key={i} className="italic text-ink-muted">
                      <code className="not-italic">{inf.type}</code>{" "}
                      <span className="font-semibold">{JSON.stringify(inf.value)}</span>{" "}
                      <Badge tone="amber">confidence {inf.confidence}</Badge>
                      <div className="mt-0.5 text-xs">{inf.reason}</div>
                    </li>
                  ))}
                  {o.extraction.inferences.length === 0 && <li className="text-ink-subtle">None.</li>}
                </ul>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            No model extraction yet — model jobs are{" "}
            {o.verification?.status === "blocked" ? "blocked (no API key)" : "pending"}. Fields
            shown above come from deterministic parsing only.
          </p>
        )}
        {o.extraction && o.extraction.missingCriticalFacts.length > 0 && (
          <p className="mt-3 text-sm font-semibold text-warn">
            Missing critical facts: {o.extraction.missingCriticalFacts.join(", ")}
          </p>
        )}
      </Panel>

      <Panel title="Score components">
        <p className="text-sm text-ink-muted">
          {rationale?.components
            ? Object.entries(rationale.components)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")
            : "No stored rationale — this opportunity has not been scored."}
          {rationale?.signals?.length ? ` — signals: ${rationale.signals.join(", ")}` : ""}
        </p>
      </Panel>

      <Panel title="Organizations &amp; roles">
        <ul className="flex flex-col gap-1 text-sm text-ink">
          {o.roles.map((r, i) => (
            <li key={i}>
              {r.name} — {r.role ?? "unknown role"}{" "}
              {r.confirmed ? (
                <Badge tone="green">confirmed</Badge>
              ) : (
                <Badge tone="amber">unconfirmed</Badge>
              )}
            </li>
          ))}
          {o.roles.length === 0 && <li className="text-ink-muted">None recorded.</li>}
        </ul>
      </Panel>

      <Panel title="Timeline">
        <Table
          caption="Recorded events for this project"
          head={
            <HeadTr>
              <Th>Date</Th>
              <Th>Event</Th>
              <Th>Stage</Th>
              <Th>Material</Th>
              <Th>Source</Th>
            </HeadTr>
          }
        >
          {o.timeline.map((e, i) => (
            <Tr key={i}>
              <Td className="whitespace-nowrap tabular-nums">{fmtDate(e.eventDate ?? e.observedAt)}</Td>
              <Td>{e.eventType}</Td>
              <Td>{stageLabel(e.resultingStage)}</Td>
              <Td>{e.materialChange ? <Badge tone="green">material</Badge> : ""}</Td>
              <Td>
                {e.sourceUrl ? (
                  <a href={e.sourceUrl} className="text-ink underline">
                    source
                  </a>
                ) : (
                  "—"
                )}
              </Td>
            </Tr>
          ))}
        </Table>
      </Panel>

      <Panel
        title="Evidence chain"
        detail={`${o.evidence.length} cited item${o.evidence.length === 1 ? "" : "s"} — every fact above traces to a row here.`}
      >
        <Table
          caption="Evidence items backing this opportunity"
          head={
            <HeadTr>
              <Th>Fact path</Th>
              <Th>Evidence</Th>
              <Th>Grade</Th>
              <Th>Source</Th>
              <Th>Retrieved</Th>
            </HeadTr>
          }
        >
          {o.evidence.map((ev) => (
            <Tr key={ev.id}>
              <Td>
                <code className="text-ink-muted">{ev.factPath}</code>
              </Td>
              <Td>{ev.evidenceText.slice(0, 240)}</Td>
              <Td>
                <Badge
                  tone={
                    ev.authorityGrade === "A" ? "green" : ev.authorityGrade === "D" ? "red" : "amber"
                  }
                >
                  {ev.authorityGrade}
                </Badge>
              </Td>
              <Td>
                {/* The chip IS the trust wedge — a named, clickable publisher
                    next to every claim, rather than an unattributed number. */}
                <SourceChip
                  label={ev.sourceName}
                  href={ev.sourceUrl}
                  {...(ev.pageOrSection ? { detail: ev.pageOrSection } : {})}
                />
              </Td>
              <Td className="whitespace-nowrap tabular-nums">{fmtDate(ev.retrievedAt)}</Td>
            </Tr>
          ))}
        </Table>
      </Panel>

      {/* EXACT HEADING — asserted by text at app.spec.ts:71. Do not reword. */}
      <Panel title="Publication gate" action={<GateBadge status={o.gate?.status as never} showDetail />}>
        <ul className="flex flex-col gap-1 text-sm text-ink">
          {o.gate?.checks.map((c) => (
            <li key={c.name}>
              <Badge tone={c.pass === true ? "green" : c.pass === false ? "red" : "amber"}>
                {c.pass === true ? "pass" : c.pass === false ? "fail" : "blocked"}
              </Badge>{" "}
              <code className="text-ink-muted">{c.name}</code> — {c.detail}
            </li>
          ))}
          {!o.gate && (
            <li className="text-ink-muted">
              The gate has not been evaluated for this record — this is not a failed gate.
            </li>
          )}
        </ul>
        {o.verification && (
          <p className="mt-2 text-sm text-ink-muted">
            Verifier status:{" "}
            <Badge tone={o.verification.status === "succeeded" ? "green" : "amber"}>
              {o.verification.status}
            </Badge>
          </p>
        )}
      </Panel>

      <Panel title="Your decision">
        <StateButtons opportunityId={o.id} state={o.state} dispositions={DISPOSITION_REASONS} />
        <p className="mt-3">
          <StartPursuitButton opportunityId={o.id} />
        </p>
      </Panel>

      <Panel title="Feedback">
        <FeedbackForm opportunityId={o.id} dispositions={DISPOSITION_REASONS} />
      </Panel>
    </main>
  );
}

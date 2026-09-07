"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  assessBook,
  buildChanges,
  compareToRecommended,
  BOOK_META,
  type ClientAssessment,
  type Triage,
} from "@/lib/broker";
import { documentUrls, type Plan } from "@/lib/plans";
import { RichText } from "@/components/RichText";

/** Links to the official filed documents, so the broker can read the source himself. */
function PlanDocs({ plan }: { plan: Plan }) {
  const docs = documentUrls(plan);
  return (
    <div className="mt-2 flex gap-3 text-sm">
      <a
        href={docs.summaryOfBenefits}
        target="_blank"
        rel="noopener noreferrer"
        className="text-emerald-800 underline"
      >
        Summary of Benefits
      </a>
      <a
        href={docs.evidenceOfCoverage}
        target="_blank"
        rel="noopener noreferrer"
        className="text-emerald-800 underline"
      >
        Evidence of Coverage
      </a>
    </div>
  );
}

/**
 * The broker surface — Tony's book of business.
 *
 * His question in October is not "what plans exist." It is "which of my sixty
 * displaced clients can I move quickly, which need a conversation, and which are
 * actually stuck?" Everything here is arranged around that triage, because sorting
 * eight weeks of undifferentiated work into a prioritised list is the whole value.
 *
 * Note this consumes the SAME rules and plan data as the member-facing assistant.
 * One capability layer, a different experience on top.
 */

const GROUPS: { key: Triage; title: string; blurb: string; tone: string }[] = [
  {
    key: "clear_port",
    title: "Port these",
    blurb: "A clean match exists — same network, drug coverage preserved, no material cost jump",
    tone: "border-emerald-400 bg-emerald-50",
  },
  {
    key: "needs_review",
    title: "Review before porting",
    blurb: "A replacement exists but something material changes — worth a call first",
    tone: "border-amber-400 bg-amber-50",
  },
  {
    key: "no_options",
    title: "No eligible plan",
    blurb: "Nothing in-market fits. These need a conversation, and may leave",
    tone: "border-red-400 bg-red-50",
  },
  {
    key: "unaffected",
    title: "Unaffected",
    blurb: "Plan continues into 2027 — no action",
    tone: "border-slate-300 bg-slate-50",
  },
];

export default function BrokerPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState<Triage | null>("clear_port");
  const [selected, setSelected] = useState<ClientAssessment | null>(null);

  const book = useMemo(() => assessBook(), []);

  if (!signedIn) {
    return (
      <div className="min-h-screen bg-slate-100">
        <Banner />
        <div className="mx-auto max-w-md px-4 py-20">
          <div className="rounded-2xl border-2 border-slate-200 bg-white p-8">
            <h1 className="text-2xl font-semibold">Agent sign-in</h1>
            <p className="mt-2 text-slate-600">
              Broker view — your book of business, triaged against the 2027 plan exits.
            </p>
            <div className="mt-6 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              <strong>Simulated sign-in.</strong> No authentication is implemented. Real deployment
              would use Humana&apos;s existing agent identity, since this exposes client data.
            </div>
            <button
              onClick={() => setSignedIn(true)}
              className="mt-6 w-full rounded-xl bg-emerald-800 px-6 py-3 text-lg font-medium text-white focus:outline-none focus:ring-4 focus:ring-emerald-300"
            >
              Continue as {BOOK_META.broker.name} ({BOOK_META.broker.agentId})
            </button>
            <Link href="/" className="mt-4 block text-center text-emerald-800 underline">
              ← Back to the member assistant
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <Banner />

      <header className="border-b border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Book of business — {BOOK_META.broker.name}</h1>
            <p className="text-sm text-slate-600">
              {BOOK_META.broker.market} · {book.totals.clients} clients ·{" "}
              <strong>{book.totals.affected} affected by 2027 exits</strong>
            </p>
          </div>
          <Link href="/" className="text-emerald-800 underline">
            Member assistant →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* Triage summary — the answer to "where do I start?" */}
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {GROUPS.map((g) => {
            const count = book.groups[g.key].length;
            return (
              <button
                key={g.key}
                onClick={() => {
                  setOpen(open === g.key ? null : g.key);
                  setSelected(null);
                }}
                className={`rounded-xl border-2 p-4 text-left transition hover:shadow-md focus:outline-none focus:ring-4 focus:ring-emerald-300 ${g.tone} ${
                  open === g.key ? "ring-4 ring-emerald-300" : ""
                }`}
              >
                <div className="text-3xl font-semibold">{count}</div>
                <div className="font-medium">{g.title}</div>
                <div className="mt-1 text-sm text-slate-600">{g.blurb}</div>
              </button>
            );
          })}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* Client list for the open group */}
          <div>
            {open && (
              <div className="rounded-xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3 font-medium">
                  {GROUPS.find((g) => g.key === open)?.title} ({book.groups[open].length})
                </div>
                <ul className="divide-y divide-slate-100">
                  {book.groups[open].map((a) => (
                    <li key={a.client.id}>
                      <button
                        onClick={() => setSelected(a)}
                        className={`w-full px-4 py-3 text-left hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-inset focus:ring-emerald-300 ${
                          selected?.client.id === a.client.id ? "bg-emerald-50" : ""
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">{a.client.name}</span>
                          <span className="text-sm text-slate-500">{a.client.age}</span>
                        </div>
                        <div className="text-sm text-slate-600">{a.headline}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {a.client.currentPlanId} · {a.client.medicationCount} medication
                          {a.client.medicationCount === 1 ? "" : "s"}
                          {a.client.doctors.length > 0 && ` · ${a.client.doctors.length} named provider(s)`}
                        </div>
                      </button>
                    </li>
                  ))}
                  {book.groups[open].length === 0 && (
                    <li className="px-4 py-6 text-slate-500">No clients in this group.</li>
                  )}
                </ul>
              </div>
            )}
          </div>

          {/* Client detail — what changes, and why */}
          <div>
            {selected ? (
              <ClientDetail assessment={selected} />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
                Select a client to see what changes for them.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ClientDetail({ assessment }: { assessment: ClientAssessment }) {
  const { client, currentPlan, recommended, reasoning, blockers, alternatives } = assessment;

  // Which plan the comparison table is showing. Defaults to the recommendation, but
  // the broker can pin any alternative against the same baseline.
  const [viewing, setViewing] = useState<Plan | undefined>(recommended);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  // Reset when a different client is selected.
  useEffect(() => {
    setViewing(recommended);
    setBrief(null);
    setBriefError(null);
  }, [client.id, recommended]);

  const changes = useMemo(
    () => (currentPlan && viewing ? buildChanges(currentPlan, viewing) : []),
    [currentPlan, viewing]
  );

  async function generateBrief() {
    setBriefing(true);
    setBriefError(null);
    try {
      const res = await fetch("/api/broker/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: client.id }),
      });
      const data = await res.json();
      if (!res.ok) setBriefError(data.message ?? "Could not generate the briefing.");
      else setBrief(data.brief);
    } catch {
      setBriefError("Could not reach the briefing service.");
    } finally {
      setBriefing(false);
    }
  }

  const isAlternative = viewing && recommended && viewing.planId !== recommended.planId;

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-lg font-semibold">{client.name}</h2>
        <p className="text-sm text-slate-600">
          {client.age} · {client.zip} · last contacted {client.lastContact}
        </p>
        <p className="mt-1 text-sm">{assessment.headline}</p>
      </div>

      {blockers.length > 0 && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-4">
          <div className="font-medium text-red-900">Blocked</div>
          <ul className="mt-1 list-disc pl-5 text-sm text-red-900">
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {currentPlan && recommended && viewing && (
        <div className="px-5 py-4">
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-100 p-3">
              <div className="text-slate-500">Ending</div>
              <div className="font-medium">{currentPlan.name}</div>
              <div className="text-slate-600">{currentPlan.planId}</div>
              <PlanDocs plan={currentPlan} />
            </div>
            <div className={`rounded-lg p-3 ${isAlternative ? "bg-sky-50" : "bg-emerald-50"}`}>
              <div className="text-slate-500">
                {isAlternative ? "Alternative (comparing)" : "Recommended"}
              </div>
              <div className="font-medium">{viewing.name}</div>
              <div className="text-slate-600">{viewing.planId}</div>
              <PlanDocs plan={viewing} />
              {isAlternative && (
                <button
                  onClick={() => setViewing(recommended)}
                  className="mt-2 text-sm text-emerald-800 underline"
                >
                  ← Back to recommended
                </button>
              )}
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">What changes</th>
                <th className="py-2 font-medium">Now</th>
                <th className="py-2 font-medium">Proposed</th>
              </tr>
            </thead>
            <tbody>
              {/* Arrow follows the NUMBER; colour carries the JUDGEMENT. They diverge
                  on Part B giveback, where a smaller figure is worse for the client. */}
              {changes.map((c) => (
                <tr key={c.label} className="border-b border-slate-100">
                  <td className="py-2 align-top">
                    {c.label}
                    {c.note && <div className="text-xs text-slate-500">{c.note}</div>}
                  </td>
                  <td className="py-2 align-top text-slate-600">{c.from}</td>
                  <td
                    className={`py-2 align-top font-medium ${
                      c.impact === "better"
                        ? "text-emerald-800"
                        : c.impact === "worse"
                          ? "text-red-800"
                          : "text-slate-600"
                    }`}
                  >
                    {c.to}
                    {c.movement === "down" && <span aria-hidden="true"> ↓</span>}
                    {c.movement === "up" && <span aria-hidden="true"> ↑</span>}
                    {c.impact !== "same" && (
                      <span className="sr-only">
                        {c.impact === "better" ? " — better for the client" : " — worse for the client"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {alternatives.length > 0 && recommended && (
            <div className="mt-5">
              <div className="text-sm font-medium text-slate-700">
                Other options — how each differs from {recommended.planId}
              </div>
              <ul className="mt-2 space-y-2">
                {alternatives.map((p) => (
                  <li key={p.planId}>
                    <button
                      onClick={() => setViewing(p)}
                      className={`w-full rounded-lg border-2 px-3 py-2 text-left text-sm transition hover:border-sky-400 focus:outline-none focus:ring-4 focus:ring-sky-200 ${
                        viewing?.planId === p.planId ? "border-sky-400 bg-sky-50" : "border-slate-200"
                      }`}
                    >
                      <div className="font-medium">
                        {p.planId} — {p.name}
                      </div>
                      <div className="text-slate-600">{compareToRecommended(recommended, p)}</div>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Click any option to compare it against the ending plan on the same rows.
              </p>
            </div>
          )}

          {/* The AI layer. Triage above is deterministic; this reads the plan documents
              and explains what the change means for this specific person. */}
          <div className="mt-5 rounded-xl border-2 border-slate-200 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">Briefing for the call</div>
                <div className="text-sm text-slate-600">
                  Reads this plan&apos;s documents and explains what changes for {client.name.split(" ")[0]}
                </div>
              </div>
              <button
                onClick={() => void generateBrief()}
                disabled={briefing}
                className="rounded-lg bg-emerald-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 focus:outline-none focus:ring-4 focus:ring-emerald-300"
              >
                {briefing ? "Reading documents…" : brief ? "Regenerate" : "Generate briefing"}
              </button>
            </div>

            {briefError && (
              <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">
                {briefError}
              </div>
            )}

            {brief && (
              <div className="mt-3 border-t border-slate-200 pt-3 text-sm leading-relaxed">
                <RichText text={brief} />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 text-sm">
        <div className="font-medium text-slate-700">Why this grouping</div>
        <ul className="mt-1 list-disc pl-5 text-slate-600">
          {reasoning.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Triage is deterministic code, not a model judgment — the agent is licensed and accountable,
          so the same client must always land in the same bucket and the reason must be auditable.
        </p>
      </div>
    </div>
  );
}

function Banner() {
  return (
    <div className="bg-slate-900 px-4 py-2 text-center text-sm text-slate-100">
      <strong>Prototype — broker view.</strong> All clients shown are fictional. No real people, no
      PHI. Not affiliated with Humana.
    </div>
  );
}

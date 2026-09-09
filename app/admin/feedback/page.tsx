"use client";

import { useCallback, useEffect, useState } from "react";
import { ACTION_LABELS, type ActionKind, type FeedbackEntry } from "@/lib/feedback-types";

type LearnedRule = {
  id: string;
  createdAt: string;
  section: string;
  rule: string;
  rationale: string;
  verification: string;
  fromFeedback: string;
  reviewerRole: string;
};

type Stats = {
  total: number;
  up: number;
  down: number;
  analysed: number;
  pending: number;
  disputed: number;
  blockers: number;
  goldenCandidates: number;
  actioned: number;
};

type Filter = "all" | "down" | "up" | "pending" | "disputed" | "golden" | "open";

const CATEGORY_LABEL: Record<string, string> = {
  retrieval_miss: "Retrieval miss",
  unsupported_claim: "Unsupported claim",
  wrong_fact: "Wrong fact",
  tone_or_clarity: "Tone / clarity",
  compliance_risk: "Compliance risk",
  out_of_scope: "Out of scope",
  correct_as_is: "Correct as is",
  exemplary: "Exemplary",
};

const SEVERITY_STYLE: Record<string, string> = {
  blocker: "bg-red-100 text-red-900 border-red-300",
  major: "bg-amber-100 text-amber-900 border-amber-300",
  minor: "bg-slate-100 text-slate-700 border-slate-300",
  none: "bg-emerald-50 text-emerald-900 border-emerald-300",
};

/**
 * Feedback review console.
 *
 * Built for the person who has to act on a batch of reviews, which shapes the whole
 * layout: the counts that lead are not "how much feedback did we get" but "what needs
 * a decision" — blockers, and disagreements between a reviewer and the triage. Volume
 * is vanity; disputes are work.
 *
 * Access control is deliberately absent and deliberately labelled. This is a prototype
 * on a public URL with synthetic data. Real feedback contains verbatim member language,
 * which is PHI the moment a real member types it, so production needs authentication
 * before this page exists at all.
 */
export default function FeedbackAdmin() {
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<{ durable: boolean; location: string } | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [rules, setRules] = useState<LearnedRule[]>([]);
  const [rulesDurable, setRulesDurable] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/feedback");
      const data = await res.json();
      setEntries(data.entries ?? []);
      setStats(data.stats ?? null);
      setStore(data.store ?? null);
      const applied = await (await fetch("/api/feedback/action")).json();
      setRules(applied.learnedRules ?? []);
      setRulesDurable(applied.durable !== false);
    } catch {
      setNote("Could not load feedback.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function analyse(id?: string) {
    setBusy(id ?? "all");
    setNote(null);
    try {
      const res = await fetch("/api/feedback/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the entry inline. On serverless the store is per-instance, so a lookup
        // by id can land on an instance that has never seen it — which is what made
        // this button look broken while every request behaved correctly.
        body: JSON.stringify(
          id ? { id, entry: entries.find((e) => e.id === id) } : { all: true }
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setNote(data.message ?? "Analysis failed.");
      } else {
        setNote(
          `Analysed ${data.analysed}${data.failed?.length ? `, ${data.failed.length} failed` : ""}.`
        );
        await load();
      }
    } catch {
      setNote("Could not reach the analysis endpoint.");
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, kind: ActionKind) {
    setActing(id + kind);
    setNote(null);
    try {
      const res = await fetch("/api/feedback/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, kind, entry: entries.find((e) => e.id === id) }),
      });
      const data = await res.json();
      if (!res.ok) setNote(data.message ?? "Could not record that.");
      else {
        setNote(
          data.applied
            ? `Applied \u2014 ${data.applied.active} correction${data.applied.active === 1 ? "" : "s"} now active. The assistant follows this from its next answer.`
            : "Recorded: " + ACTION_LABELS[kind] + "."
        );
        await load();
      }
    } catch {
      setNote("Could not reach the server.");
    } finally {
      setActing(null);
    }
  }

  async function revoke(id: string) {
    setActing("revoke" + id);
    try {
      const res = await fetch("/api/feedback/action?id=" + encodeURIComponent(id), { method: "DELETE" });
      const data = await res.json();
      setNote(data.ok ? `Rule revoked. ${data.remaining} still active.` : "Could not revoke that rule.");
      await load();
    } catch {
      setNote("Could not reach the server.");
    } finally {
      setActing(null);
    }
  }

  const shown = entries.filter((e) => {
    switch (filter) {
      case "down":
        return e.rating === "down";
      case "up":
        return e.rating === "up";
      case "pending":
        return !e.analysis;
      case "disputed":
        return e.analysis?.agrees === false;
      case "golden":
        return Boolean(e.analysis?.goldenSetCase);
      case "open":
        return Boolean(e.analysis) && (!e.action || e.action.kind === "none");
      default:
        return true;
    }
  });

  const FILTERS: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "All", count: stats?.total },
    { key: "down", label: "Negative", count: stats?.down },
    { key: "up", label: "Positive", count: stats?.up },
    { key: "pending", label: "Not triaged", count: stats?.pending },
    { key: "disputed", label: "Disputed", count: stats?.disputed },
    { key: "golden", label: "Golden candidates", count: stats?.goldenCandidates },
    { key: "open", label: "Triaged, not actioned" },
  ];

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div role="note" className="bg-slate-900 px-4 py-2 text-center text-xs text-slate-100">
        <strong>Prototype admin — no authentication.</strong> Synthetic data only. Production would
        require auth before this page exists: real feedback contains verbatim member language.
      </div>

      <header className="border-b border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Feedback review</h1>
            <p className="text-xs text-slate-600">
              UAT, legal and compliance reviews · AI triage assesses each one rather than assuming
              the reviewer is right
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <button
              onClick={() => void analyse()}
              disabled={busy !== null || !stats?.pending}
              className="rounded bg-emerald-800 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {busy === "all" ? "Analysing…" : `Triage all pending${stats?.pending ? ` (${stats.pending})` : ""}`}
            </button>
            <a href="/api/feedback/action" target="_blank" rel="noreferrer" className="text-emerald-800 underline">
              Export approved →
            </a>
            <a href="/" className="text-emerald-800 underline">
              ← Assistant
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5">
        {store && !store.durable && (
          <div role="note" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong>Storage is ephemeral on this deployment.</strong> Writes go to the instance temp
            directory and are lost when it recycles, so treat anything submitted here as a demo
            rather than a record. Real UAT needs a durable store &mdash; set{" "}
            <code>FEEDBACK_STORE_PATH</code> to a mounted volume, or swap the two IO functions in{" "}
            <code>lib/feedback.ts</code> for a database client.
          </div>
        )}
        {/* What the loop has actually changed. Listed first because a self-modifying
            system whose modifications are invisible is the thing nobody should ship. */}
        <section className="mb-5 rounded-xl border border-sky-300 bg-sky-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-sky-900">
              Active corrections{" "}
              <span className="font-normal text-sky-800">
                &middot; {rules.length} rule{rules.length === 1 ? "" : "s"} appended to the assistant&rsquo;s prompt right now
              </span>
            </h2>
            {!rulesDurable && (
              <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-900">
                Instance-scoped &mdash; commit data/learned-rules.json to make permanent
              </span>
            )}
          </div>

          {rules.length === 0 ? (
            <p className="mt-1.5 text-xs text-sky-900">
              None yet. Accepting a proposed correction on a piece of feedback adds it here, and it
              takes effect on the assistant&rsquo;s next answer.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {rules.map((r) => (
                <li key={r.id} className="rounded border border-sky-200 bg-white p-2 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap text-slate-800">{r.rule}</p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {r.section} &middot; from {r.reviewerRole} feedback {r.fromFeedback} &middot;{" "}
                        {new Date(r.createdAt).toLocaleString()}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-600">{r.rationale}</p>
                    </div>
                    <button
                      onClick={() => void revoke(r.id)}
                      disabled={acting !== null}
                      className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {acting === "revoke" + r.id ? "Revoking\u2026" : "Revoke"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-[11px] text-sky-800">
            Corrections refine behaviour inside existing limits. They cannot move a boundary &mdash;
            rule text that tries to is rejected before it is stored, and the overlay tells the model
            that the boundaries above it win.
          </p>
        </section>

        {/* Blockers and disputes lead, because those are the two that need a human. */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card label="Needs a decision" value={(stats?.blockers ?? 0) + (stats?.disputed ?? 0)} tone="alert" />
          <Card label="Disputed by triage" value={stats?.disputed ?? 0} tone="warn" />
          <Card label="Not yet triaged" value={stats?.pending ?? 0} tone="plain" />
          <Card label="Actioned" value={stats?.actioned ?? 0} tone="good" />
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === f.key
                  ? "border-emerald-700 bg-emerald-800 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {f.label}
              {typeof f.count === "number" && ` · ${f.count}`}
            </button>
          ))}
        </div>

        {note && (
          <p role="status" className="mb-3 rounded border border-slate-300 bg-white px-3 py-2 text-xs">
            {note}
          </p>
        )}

        {loaded && entries.length === 0 && (
          <div className="rounded-xl border border-slate-300 bg-white p-6 text-sm text-slate-600">
            <p className="font-medium text-slate-800">No feedback yet.</p>
            <p className="mt-1">
              Rate an answer on the assistant with 👍 or 👎 and it will appear here.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Note: on a serverless deployment the store is ephemeral — entries survive only until
              the instance recycles. See the storage seam in <code>lib/feedback.ts</code>.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {shown.map((e) => {
            const a = e.analysis;
            const open = expanded === e.id;
            return (
              <article key={e.id} className="rounded-xl border border-slate-300 bg-white">
                <button
                  onClick={() => setExpanded(open ? null : e.id)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                >
                  <span className="text-base" aria-hidden="true">
                    {e.rating === "up" ? "👍" : "👎"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-slate-600">
                        {e.reviewerRole}
                      </span>
                      {a && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${
                            SEVERITY_STYLE[a.severity] ?? SEVERITY_STYLE.minor
                          }`}
                        >
                          {CATEGORY_LABEL[a.category] ?? a.category}
                          {a.severity !== "none" && ` · ${a.severity}`}
                        </span>
                      )}
                      {a && !a.agrees && (
                        <span className="rounded border border-purple-300 bg-purple-50 px-1.5 py-0.5 text-[11px] text-purple-900">
                          triage disagrees
                        </span>
                      )}
                      {!a && (
                        <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600">
                          not triaged
                        </span>
                      )}
                      <span className="text-[11px] text-slate-400">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-700">
                      {e.comment || <em className="text-slate-400">no comment</em>}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400" aria-hidden="true">
                    {open ? "▲" : "▼"}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-slate-200 px-3 py-3 text-xs">
                    <Section title="Question">
                      <p className="text-slate-700">{e.question || "(not captured)"}</p>
                    </Section>

                    <Section title="Answer reviewed">
                      <p className="whitespace-pre-wrap text-slate-700">{e.answer}</p>
                    </Section>

                    {e.comment && (
                      <Section title={`Reviewer comment (${e.reviewerRole})`}>
                        <p className="text-slate-700">{e.comment}</p>
                      </Section>
                    )}

                    <Section title="Evidence the answer was built from">
                      {e.toolsUsed.length > 0 && (
                        <p className="mb-1 text-slate-500">Tools: {e.toolsUsed.join(", ")}</p>
                      )}
                      {e.evidence.length === 0 ? (
                        <p className="text-slate-500">No document passages retrieved.</p>
                      ) : (
                        <ul className="space-y-1">
                          {e.evidence.map((p, i) => (
                            <li key={i} className="rounded bg-slate-50 p-2">
                              <span className="font-medium text-slate-700">
                                {p.document}, p.{p.page}
                              </span>
                              <p className="mt-0.5 text-slate-600">{p.text.slice(0, 400)}…</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Section>

                    <p className="mb-3 text-[11px] text-slate-400">
                      build <code className="font-mono">{e.commit}</code> · corpus{" "}
                      <code className="font-mono">{e.corpusVersion.slice(0, 8)}</code> · model{" "}
                      <code className="font-mono">{e.model}</code>
                    </p>

                    {!a ? (
                      <button
                        onClick={() => void analyse(e.id)}
                        disabled={busy !== null}
                        className="rounded bg-emerald-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {busy === e.id ? "Analysing…" : "Triage this"}
                      </button>
                    ) : (
                      <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                        <h3 className="mb-1 text-xs font-semibold text-slate-800">
                          AI triage
                          <span className="ml-2 font-normal text-slate-500">
                            {a.agrees ? "agrees with reviewer" : "does NOT agree with reviewer"} ·{" "}
                            {a.confidence} confidence
                          </span>
                        </h3>
                        <p className="text-slate-700">{a.assessment}</p>

                        {a.disagreementNote && (
                          <div className="mt-2 rounded border border-purple-300 bg-purple-50 p-2">
                            <p className="font-medium text-purple-900">Why it disagrees</p>
                            <p className="mt-0.5 text-purple-900">{a.disagreementNote}</p>
                          </div>
                        )}

                        {a.remediation.length > 0 && (
                          <div className="mt-2">
                            <p className="font-medium text-slate-800">Suggested next steps</p>
                            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-700">
                              {a.remediation.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {a.goldenSetCase && (
                          <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2">
                            <p className="font-medium text-emerald-900">
                              Proposed regression test — lock this behaviour in
                            </p>
                            <p className="mt-0.5 text-emerald-900">{a.goldenSetCase.rationale}</p>
                            <pre className="mt-1.5 overflow-x-auto rounded bg-white p-2 text-[11px] text-slate-800">
{JSON.stringify(
  {
    question: a.goldenSetCase.question,
    mustAppear: a.goldenSetCase.mustAppear,
    mustNotAppear: a.goldenSetCase.mustNotAppear,
  },
  null,
  2
)}
                            </pre>
                            <p className="mt-1 text-[11px] text-emerald-800">
                              This is what &ldquo;reinforcement&rdquo; means here — a regression
                              test, not a weight update.
                            </p>
                          </div>
                        )}

                        {a.promptFix && (
                          <div className="mt-2 rounded border border-sky-300 bg-sky-50 p-2">
                            <p className="font-medium text-sky-900">
                              Proposed prompt change &mdash; stop it happening again
                            </p>
                            <p className="mt-0.5 text-sky-900">
                              Section: <strong>{a.promptFix.section}</strong>
                            </p>
                            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] text-slate-800">
{a.promptFix.rule}
                            </pre>
                            <p className="mt-1 text-sky-900">{a.promptFix.rationale}</p>
                            <p className="mt-1 text-[11px] text-sky-800">
                              Verify: {a.promptFix.verification}
                            </p>
                          </div>
                        )}

                        {/* Actions record a DECISION and stage an artifact. They never edit
                            the golden set or the prompt directly &mdash; a human merges those. */}
                        <div className="mt-3 border-t border-slate-300 pt-2">
                          {e.action && e.action.kind !== "none" ? (
                            <p className="text-emerald-900">
                              <strong>{ACTION_LABELS[e.action.kind]}</strong>{" "}
                              <span className="text-slate-500">
                                &middot; {new Date(e.action.takenAt).toLocaleString()}
                              </span>
                            </p>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="mr-1 text-slate-600">Action:</span>
                              {a.goldenSetCase && (
                                <ActionButton
                                  label="Add to golden set"
                                  busy={acting === e.id + "golden_set"}
                                  tone="good"
                                  onClick={() => void act(e.id, "golden_set")}
                                />
                              )}
                              {a.promptFix && (
                                <ActionButton
                                  label="Stage prompt change"
                                  busy={acting === e.id + "prompt_change"}
                                  tone="info"
                                  onClick={() => void act(e.id, "prompt_change")}
                                />
                              )}
                              <ActionButton
                                label="No change needed"
                                busy={acting === e.id + "wont_fix"}
                                tone="plain"
                                onClick={() => void act(e.id, "wont_fix")}
                              />
                              <ActionButton
                                label="Escalate"
                                busy={acting === e.id + "escalated"}
                                tone="warn"
                                onClick={() => void act(e.id, "escalated")}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function ActionButton({
  label, busy, tone, onClick,
}: {
  label: string;
  busy: boolean;
  tone: "good" | "info" | "warn" | "plain";
  onClick: () => void;
}) {
  const styles = {
    good: "border-emerald-400 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
    info: "border-sky-400 bg-sky-50 text-sky-900 hover:bg-sky-100",
    warn: "border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100",
    plain: "border-slate-300 bg-white text-slate-700 hover:bg-slate-100",
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={"rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50 " + styles}
    >
      {busy ? "Saving\u2026" : label}
    </button>
  );
}

function Card({ label, value, tone }: { label: string; value: number; tone: "alert" | "warn" | "good" | "plain" }) {
  const styles = {
    alert: "border-red-300 bg-red-50 text-red-900",
    warn: "border-purple-300 bg-purple-50 text-purple-900",
    good: "border-emerald-300 bg-emerald-50 text-emerald-900",
    plain: "border-slate-300 bg-white text-slate-800",
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${styles}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

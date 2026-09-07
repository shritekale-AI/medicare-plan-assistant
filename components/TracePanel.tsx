"use client";

/**
 * Shows what the assistant actually did to answer.
 *
 * This is not decoration. The central claim of this prototype is that plan facts come
 * from deterministic tools and cited documents rather than from the model's own
 * recall. A claim like that should be visible, not asserted — so every tool call,
 * its inputs, and a summary of its result are surfaced here.
 *
 * It also makes the demo legible to a technical audience without them reading code.
 */

import { useState } from "react";

export type TraceEntry = { tool: string; input: unknown; summary: string };

const TOOL_LABELS: Record<string, string> = {
  check_eligibility: "Checked eligibility rules",
  search_plans: "Searched available plans",
  get_plan_details: "Looked up plan details",
  compare_plans: "Compared plans",
  estimate_annual_cost: "Estimated annual cost",
  search_plan_documents: "Searched official plan documents",
  check_provider_network: "Checked provider network status",
  find_plans_keeping_providers: "Checked which plans keep their doctors",
  create_handoff_summary: "Prepared handoff to a human advocate",
  compact_conversation: "Summarised earlier conversation (smaller model)",
};

const DETERMINISTIC = new Set([
  "check_eligibility",
  "search_plans",
  "get_plan_details",
  "compare_plans",
  "estimate_annual_cost",
  // Network status is a lookup, not a retrieval — a value in a table, like a premium.
  "check_provider_network",
  "find_plans_keeping_providers",
]);

export function TracePanel({ trace }: { trace: TraceEntry[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (trace.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="mb-2 font-medium text-slate-600">
        How this answer was produced
      </div>
      <ul className="space-y-1.5">
        {trace.map((entry, i) => {
          const isOpen = expanded === i;
          const kind = DETERMINISTIC.has(entry.tool)
            ? { label: "rules", cls: "bg-emerald-100 text-emerald-800" }
            : entry.tool === "search_plan_documents"
              ? { label: "retrieval", cls: "bg-sky-100 text-sky-800" }
              : { label: "action", cls: "bg-amber-100 text-amber-800" };

          return (
            <li key={i}>
              <button
                onClick={() => setExpanded(isOpen ? null : i)}
                className="flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-slate-100"
              >
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${kind.cls}`}>
                  {kind.label}
                </span>
                <span className="flex-1 text-slate-700">
                  {TOOL_LABELS[entry.tool] ?? entry.tool}
                  <span className="text-slate-500"> — {entry.summary}</span>
                </span>
                <span className="text-slate-400">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <pre className="mt-1 overflow-x-auto rounded bg-slate-800 p-2 text-xs text-slate-100">
                  {JSON.stringify(entry.input, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-500">
        Plan facts come from these calls, not from the model&apos;s own knowledge.
        <span className="text-emerald-700"> Rules</span> are deterministic code;
        <span className="text-sky-700"> retrieval</span> returns cited passages from official plan documents.
      </p>
    </div>
  );
}

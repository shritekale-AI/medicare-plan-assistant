"use client";

import { useState } from "react";
import {
  REVIEWER_ROLES,
  type FeedbackAnalysis,
  type FeedbackEntry,
  type Rating,
  type ReviewerRole,
} from "@/lib/feedback-types";

type Props = {
  /** Unique per rendered answer, for input ids only. */
  uid: string;
  question: string;
  answer: string;
  toolsUsed: string[];
  evidence: { document: string; page: number; text: string }[];
  identityEstablished: boolean;
  commit: string;
};

/**
 * Rate one answer, see what the triage made of it, and accept the fix — without leaving
 * the conversation.
 *
 * THE ORIGINAL SHAPE WAS WRONG. Feedback went into a queue and a reviewer had to open a
 * separate console and press a button to get an assessment. Two problems. The person who
 * just wrote the comment is the one best placed to judge whether the assessment is right,
 * and they had already moved on. And on serverless the queue lived in an instance temp
 * directory, so the console's button did its work against state a later request could
 * not see — it looked broken while behaving correctly.
 *
 * So triage runs on submit and the result comes back in the same response. If it proposes
 * a rule, accepting it here applies it to the assistant's next turn.
 */
export function FeedbackControls({
  uid, question, answer, toolsUsed, evidence, identityEstablished, commit,
}: Props) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [role, setRole] = useState<ReviewerRole>("uat");
  const [state, setState] = useState<"idle" | "open" | "sending" | "triaged" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [entry, setEntry] = useState<FeedbackEntry | null>(null);
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  function choose(next: Rating) {
    setRating(next);
    setState("open");
  }

  async function submit() {
    if (!rating) return;
    setState("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating, comment, reviewerRole: role, question, answer,
          toolsUsed, evidence, identityEstablished, commit,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.message ?? "Could not save that.");
        setState("error");
        return;
      }
      setEntry(data.entry ?? null);
      setAnalysis(data.triage ?? null);
      setState("triaged");
    } catch {
      setErrorMsg("Could not reach the server.");
      setState("error");
    }
  }

  async function accept(kind: "prompt_change" | "golden_set") {
    if (!entry) return;
    setApplying(kind);
    setErrorMsg("");
    try {
      const res = await fetch("/api/feedback/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, kind, entry }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.message ?? "Could not apply that.");
      } else if (kind === "prompt_change") {
        setApplied(
          data.applied
            ? `Applied. ${data.applied.active} correction${data.applied.active === 1 ? "" : "s"} now active — the assistant follows this from your next message.`
            : "Recorded."
        );
      } else {
        setApplied("Added to the golden set queue. Export it from the review console to open a pull request.");
      }
    } catch {
      setErrorMsg("Could not reach the server.");
    } finally {
      setApplying(null);
    }
  }

  /* ---------- after triage ---------- */
  if (state === "triaged") {
    const agreeTone = analysis
      ? analysis.agrees
        ? "border-emerald-300 bg-emerald-50 text-emerald-900"
        : "border-purple-300 bg-purple-50 text-purple-900"
      : "border-slate-300 bg-slate-50 text-slate-700";

    return (
      <div className="mt-1.5 rounded-lg border border-slate-300 bg-white p-2.5 text-xs">
        {!analysis ? (
          <p role="status" className="text-emerald-800">
            Thanks — feedback recorded. Automatic review is unavailable right now, so it is queued
            for the console.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded border px-1.5 py-0.5 font-medium ${agreeTone}`}>
                {analysis.agrees ? "Agrees with you" : "Does not agree"}
              </span>
              <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-700">
                {analysis.category.replace(/_/g, " ")}
                {analysis.severity !== "none" && ` · ${analysis.severity}`}
              </span>
              <span className="text-slate-400">{analysis.confidence} confidence</span>
            </div>

            <p className="mt-1.5 text-slate-700">{analysis.assessment}</p>

            {analysis.disagreementNote && (
              <div className="mt-1.5 rounded border border-purple-300 bg-purple-50 p-1.5">
                <p className="font-medium text-purple-900">Why it disagrees</p>
                <p className="mt-0.5 text-purple-900">{analysis.disagreementNote}</p>
              </div>
            )}

            {analysis.promptFix && !applied && (
              <div className="mt-2 rounded border border-sky-300 bg-sky-50 p-2">
                <p className="font-medium text-sky-900">Proposed correction</p>
                <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-slate-800">
                  {analysis.promptFix.rule}
                </p>
                <p className="mt-1 text-[11px] text-sky-800">{analysis.promptFix.rationale}</p>
                <button
                  onClick={() => void accept("prompt_change")}
                  disabled={applying !== null}
                  className="mt-1.5 rounded bg-sky-800 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {applying === "prompt_change" ? "Applying…" : "Accept and apply"}
                </button>
              </div>
            )}

            {analysis.goldenSetCase && !applied && (
              <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2">
                <p className="font-medium text-emerald-900">Worth protecting as a regression test</p>
                <p className="mt-0.5 text-[11px] text-emerald-900">{analysis.goldenSetCase.rationale}</p>
                <button
                  onClick={() => void accept("golden_set")}
                  disabled={applying !== null}
                  className="mt-1.5 rounded bg-emerald-800 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {applying === "golden_set" ? "Adding…" : "Add to golden set"}
                </button>
              </div>
            )}

            {!analysis.promptFix && !analysis.goldenSetCase && !applied && (
              <p className="mt-1.5 text-[11px] text-slate-500">
                No automatic correction proposed — this one needs a person. It is in the review
                console.
              </p>
            )}

            {applied && (
              <p role="status" className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-1.5 font-medium text-emerald-900">
                {applied}
              </p>
            )}

            {errorMsg && (
              <p role="alert" className="mt-1.5 text-red-800">
                {errorMsg}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  /* ---------- rating and comment ---------- */
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <span className="sr-only" id={`fb-label-${uid}`}>
          Was this answer helpful?
        </span>
        <button
          onClick={() => choose("up")}
          aria-label="This answer was good"
          aria-pressed={rating === "up"}
          className={`rounded px-1.5 py-0.5 transition hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
            rating === "up" ? "bg-emerald-100 text-emerald-900" : ""
          }`}
        >
          <span aria-hidden="true">👍</span>
        </button>
        <button
          onClick={() => choose("down")}
          aria-label="This answer had a problem"
          aria-pressed={rating === "down"}
          className={`rounded px-1.5 py-0.5 transition hover:bg-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 ${
            rating === "down" ? "bg-red-100 text-red-900" : ""
          }`}
        >
          <span aria-hidden="true">👎</span>
        </button>
        {state === "idle" && <span className="text-slate-400">Rate this answer</span>}
      </div>

      {(state === "open" || state === "sending" || state === "error") && (
        <div className="mt-1.5 rounded-lg border border-slate-300 bg-slate-50 p-2">
          <label htmlFor={`fb-comment-${uid}`} className="block text-xs font-medium text-slate-700">
            {rating === "up"
              ? "What was right about it? (optional — this can become a regression test)"
              : "What was wrong with it? (optional, but the more specific the better)"}
          </label>
          <textarea
            id={`fb-comment-${uid}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            /* 16px minimum — anything smaller triggers iOS Safari's zoom-on-focus. */
            className="mt-1 w-full resize-none rounded border border-slate-300 px-2 py-1.5 text-base focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-200 sm:text-xs"
            placeholder={
              rating === "up"
                ? "e.g. named a clear best fit and still routed to a licensed advocate; cited the page"
                : "e.g. quoted the wrong plan's copay; the page cited doesn't say this"
            }
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <label htmlFor={`fb-role-${uid}`} className="text-xs text-slate-600">
              Reviewing as
            </label>
            <select
              id={`fb-role-${uid}`}
              value={role}
              onChange={(e) => setRole(e.target.value as ReviewerRole)}
              className="rounded border border-slate-300 px-1.5 py-1 text-base sm:text-xs"
            >
              {REVIEWER_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => void submit()}
              disabled={state === "sending"}
              className="rounded bg-emerald-800 px-3 py-1 text-xs font-medium text-white focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:opacity-50"
            >
              {state === "sending" ? "Reviewing…" : "Submit"}
            </button>
            <button
              onClick={() => {
                setState("idle");
                setRating(null);
                setComment("");
              }}
              className="text-xs text-slate-600 underline"
            >
              Cancel
            </button>
          </div>
          {state === "sending" && (
            <p className="mt-1 text-[11px] text-slate-500">
              Checking your feedback against the answer and the sources it used…
            </p>
          )}
          {state === "error" && (
            <p role="alert" className="mt-1 text-xs text-red-800">
              {errorMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

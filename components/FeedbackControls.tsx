"use client";

import { useState } from "react";
import { REVIEWER_ROLES, type Rating, type ReviewerRole } from "@/lib/feedback-types";

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
 * Thumbs up / down on one answer, and a comment box that opens once a rating is
 * chosen.
 *
 * The comment is optional on purpose. Requiring it would cut the response rate hard,
 * and a bare thumbs-down still carries signal — but the box opens automatically,
 * because a reviewer who has just formed an opinion is the most likely they will ever
 * be to write it down. Asking a moment later gets nothing.
 *
 * The reviewer's role is captured because it changes what the feedback means: a
 * compliance reviewer's objection is a release gate, a UAT tester's is a bug, and a
 * member's is a signal about clarity. Same rating, different queue.
 */
export function FeedbackControls({ uid, question, answer, toolsUsed, evidence, identityEstablished, commit }: Props) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [role, setRole] = useState<ReviewerRole>("uat");
  const [state, setState] = useState<"idle" | "open" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  function choose(next: Rating) {
    setRating(next);
    setState("open");
  }

  async function submit() {
    if (!rating) return;
    setState("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment, reviewerRole: role, question, answer, toolsUsed, evidence, identityEstablished, commit }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.message ?? "Could not save that.");
        setState("error");
        return;
      }
      setState("sent");
    } catch {
      setErrorMsg("Could not reach the server.");
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <p role="status" className="mt-1 text-xs text-emerald-800">
        Thanks — feedback recorded{rating === "down" ? " and queued for review" : ""}.
      </p>
    );
  }

  return (
    <div className="mt-1">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <span id={`fb-label-${uid}`} className="sr-only">
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
            className="mt-1 w-full resize-none rounded border border-slate-300 px-2 py-1 text-xs focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            placeholder={
              rating === "up"
                ? "e.g. correctly refused to recommend, cited the page"
                : "e.g. quoted the wrong plan's copay; page cited doesn't say this"
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
              className="rounded border border-slate-300 px-1.5 py-1 text-xs"
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
              {state === "sending" ? "Saving…" : "Submit"}
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

/**
 * Feedback types and constants — the client-safe half.
 *
 * Split from `lib/feedback.ts` because the reviewer widget is a client component and
 * needs REVIEWER_ROLES and these types. The store imports `fs`, and a single module
 * holding both meant Next.js tried to bundle `fs` for the browser and the whole page
 * 500'd. Types and constants have no runtime dependency; the store does. They belong
 * in separate files.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * The people who decide whether this ships are not its users. Legal, compliance, and
 * UAT reviewers read answers and form judgements that never reach the build unless
 * there is somewhere to put them. Before this, the loop was a person noticing
 * something, mentioning it in a meeting, and someone remembering. That is not a loop.
 *
 * WHAT "REINFORCEMENT" MEANS HERE — said precisely, because the phrase invites a
 * misunderstanding worth heading off. Nothing here trains a model. There are no
 * weights to update; the model is a hosted API and fine-tuning was rejected because
 * it destroys provenance (a compliance reviewer accepts a citation, not "it's in the
 * weights"). What positive feedback actually does is become a REGRESSION TEST: a
 * reviewer saying "this answer is exactly right" is the cheapest possible source of a
 * golden-set case, because a domain expert has already done the labelling. Good
 * behaviour gets locked in so a later prompt change cannot silently undo it.
 *
 * Negative feedback goes the other way — into a triage queue where a model assesses
 * it and proposes a remediation. Note the direction of authority: the model does not
 * obey the reviewer. Reviewers are sometimes wrong, and a compliance reviewer flagging
 * a correct answer is a real event with a real cost, because "fixing" it would make
 * the system worse. So the analysis is allowed to disagree, and has to say why.
 *
 * STORAGE — this is a labelled seam, not a production design. Feedback is appended to
 * a JSON file, which works locally and on any single long-lived server. On Vercel the
 * filesystem is ephemeral, so entries survive only until the instance recycles. Real
 * UAT needs a datastore; `FEEDBACK_STORE_PATH` and the two functions below are the
 * whole surface that would have to change.
 */

export type Rating = "up" | "down";

/** Who is reviewing. Their role changes how a comment should be weighted, so it is captured. */
export type ReviewerRole = "uat" | "legal" | "compliance" | "clinical" | "broker" | "member" | "other";

export const REVIEWER_ROLES: { value: ReviewerRole; label: string }[] = [
  { value: "uat", label: "UAT tester" },
  { value: "compliance", label: "Compliance" },
  { value: "legal", label: "Legal" },
  { value: "clinical", label: "Clinical / pharmacy" },
  { value: "broker", label: "Broker / agent" },
  { value: "member", label: "Member (pre-pilot)" },
  { value: "other", label: "Other" },
];

/** A retrieved passage, carried so the analysis can check the answer against its evidence. */
export type FeedbackEvidence = { document: string; page: number; text: string };

export type FeedbackEntry = {
  id: string;
  createdAt: string;
  rating: Rating;
  comment: string;
  reviewerRole: ReviewerRole;
  /** The exchange being judged. */
  question: string;
  answer: string;
  /**
   * Whether the conversation had an authenticated account behind it.
   *
   * Added after a triage pass INFERRED an authenticated session from the presence of a
   * check_eligibility call and cleared an answer on that basis. It had no way to know.
   * A judge reasoning from an absent signal will be confidently wrong at exactly the
   * rate the signal is absent, so the signal is now recorded rather than guessed at.
   */
  identityEstablished?: boolean;
  /** Tools called, and any passages retrieved — what the answer was actually built from. */
  toolsUsed: string[];
  evidence: FeedbackEvidence[];
  /** Provenance: which build, corpus, and model produced the answer. */
  commit: string;
  corpusVersion: string;
  model: string;
  /** Populated once triaged. Absent until then. */
  analysis?: FeedbackAnalysis;
  /** Populated once a human has decided what to do about it. */
  action?: FeedbackAction;
};

/**
 * What a reviewer decided to DO about a piece of feedback.
 *
 * Triage produces an opinion; this records a decision. Keeping them separate matters:
 * the queue needs to distinguish "nobody has looked at this" from "someone looked and
 * chose to do nothing", and only the second is actually closed.
 */
export type ActionKind = "none" | "golden_set" | "prompt_change" | "wont_fix" | "escalated";

export type FeedbackAction = {
  kind: ActionKind;
  takenAt: string;
  /** Free-text note from whoever actioned it. */
  note?: string;
  /** Snapshot of what was accepted, so the decision survives a later re-triage. */
  accepted?: {
    goldenSetCase?: FeedbackAnalysis["goldenSetCase"];
    promptFix?: PromptFix;
  };
};

/**
 * A concrete, reviewable edit to the system prompt.
 *
 * Deliberately not applied automatically. A prompt is the behavioural specification of
 * a regulated product; an agent editing it in response to one review, with no eval run
 * and no human reading the diff, is how a system quietly drifts. So this is generated,
 * shown, and staged — and a person merges it.
 */
export type PromptFix = {
  /** Which part of lib/prompts.ts it belongs in, e.g. "How to be correct". */
  section: string;
  /** The rule to add, written in the voice of the existing prompt. */
  rule: string;
  /** Why this specific wording, and what it prevents. */
  rationale: string;
  /** How to tell it worked — the eval that should now pass. */
  verification: string;
};

export const ACTION_LABELS: Record<ActionKind, string> = {
  none: "No action yet",
  golden_set: "Added to golden set",
  prompt_change: "Prompt change staged",
  wont_fix: "Reviewed — no change needed",
  escalated: "Escalated for human decision",
};

export type FeedbackAnalysis = {
  analysedAt: string;
  /** Does the assessment agree with the reviewer? Reviewers can be wrong. */
  agrees: boolean;
  /** Confidence in that call, so a borderline judgement is not read as settled. */
  confidence: "high" | "medium" | "low";
  category:
    | "retrieval_miss"
    | "unsupported_claim"
    | "wrong_fact"
    | "tone_or_clarity"
    | "compliance_risk"
    | "out_of_scope"
    | "correct_as_is"
    | "exemplary";
  severity: "blocker" | "major" | "minor" | "none";
  /** What the assessment concluded, in plain language a non-engineer can act on. */
  assessment: string;
  /** Concrete next steps. Empty for feedback needing no change. */
  remediation: string[];
  /**
   * For good answers: a proposed regression case, so the behaviour is locked in.
   * This is the "reinforcement" path — an eval case, not a weight update.
   */
  goldenSetCase?: {
    question: string;
    mustAppear: string[];
    mustNotAppear: string[];
    rationale: string;
  };
  /** Present only when the assessment disagrees with the reviewer. Says why, for a human to arbitrate. */
  disagreementNote?: string;
  /**
   * For feedback that reveals a genuine behavioural defect: the specific prompt rule
   * that would prevent a recurrence. Staged for a human to merge, never auto-applied.
   */
  promptFix?: PromptFix;
};

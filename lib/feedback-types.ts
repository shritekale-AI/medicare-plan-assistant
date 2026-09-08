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
  /** Tools called, and any passages retrieved — what the answer was actually built from. */
  toolsUsed: string[];
  evidence: FeedbackEvidence[];
  /** Provenance: which build, corpus, and model produced the answer. */
  commit: string;
  corpusVersion: string;
  model: string;
  /** Populated once triaged. Absent until then. */
  analysis?: FeedbackAnalysis;
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
};

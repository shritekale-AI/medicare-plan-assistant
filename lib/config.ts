/**
 * Single source of truth for models and generation settings.
 *
 * WHY MODEL ROUTING:
 * not every task needs a frontier model. Conversation summarisation and grounding
 * checks are narrow, well-specified jobs — routing them to a smaller, faster model
 * cuts cost and latency without touching answer quality, because the frontier model
 * still handles every user-facing response.
 *
 * That matters at AEP volume specifically, where traffic is enormously repetitive:
 * most questions are the same twenty questions asked by different people.
 *
 * WHY THE VERSIONS ARE PINNED HERE:
 * model behaviour — including boundary adherence — shifts between versions. A model
 * upgrade is a behavioural change to a regulated system, not a dependency bump. One
 * home for the version lets the eval harness compare against the validated baseline
 * and refuse to report a clean run under an unvalidated model.
 */

export const MODELS = {
  /** User-facing responses. Every answer a member reads comes from this. */
  primary: "claude-sonnet-5",
  /**
   * Narrow background tasks: conversation summarisation, groundedness judging.
   * Never generates anything a member sees.
   */
  fast: "claude-haiku-4-5-20251001",
} as const;

/** Back-compat alias — the model under evaluation is always the primary one. */
export const MODEL = MODELS.primary;

export const GENERATION = {
  maxTokens: 1600,
  /** Cap on agent loop iterations, so a tool cycle can't run away. */
  maxTurns: 8,
} as const;

/** Bounds on publicly reachable input. */
export const LIMITS = {
  maxMessageChars: 4000,
  maxMessages: 40,
  rateWindowMs: 60_000,
  rateMaxRequests: 12,
  /** Max image upload, before base64 encoding. */
  maxImageBytes: 4 * 1024 * 1024,
} as const;

/**
 * Conversation compaction.
 *
 * Long sessions are a real need here, not a hypothetical: the caregiver persona
 * researches across two sittings and has to defend the choice to a third person.
 * Truncating the middle of that conversation loses exactly the reasoning she needs.
 * Summarising it keeps the thread while bounding token growth.
 */
export const COMPACTION = {
  /** Compaction begins once the conversation exceeds this many messages. */
  triggerAfterMessages: 14,
  /** Most recent messages always kept verbatim — recency carries the most signal. */
  keepRecentMessages: 8,
} as const;

/**
 * Single source of truth for the model and generation settings.
 *
 * WHY THIS ISN'T JUST INLINE IN THE ROUTE:
 * model behaviour — including boundary adherence — can shift between versions. A
 * model upgrade is a behavioural change to a regulated system, not a dependency
 * bump. Pinning the version in one place lets the eval harness read it, compare it
 * against the version the golden set was last validated on, and refuse to report a
 * clean run under an unvalidated model.
 */

export const MODEL = "claude-sonnet-5";

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
} as const;

/**
 * Broker book-of-business triage.
 *
 * THE PROBLEM THIS SOLVES:
 * Tony has ~400 clients. In early October, sixty of them get non-renewal letters at
 * once, and he has eight weeks to resolve every one — while competitors court the
 * same people. Today that's 30–40 minutes of manual portal work per client.
 *
 * His real question isn't "what plans exist." It's "which of these sixty can I move
 * quickly, which need a conversation, and which are actually stuck?" Sorting by that
 * is what turns eight weeks of undifferentiated work into a prioritised list.
 *
 * WHY THIS IS DETERMINISTIC CODE, NOT A MODEL CALL:
 * Tony is licensed and personally accountable for every placement. He needs the same
 * answer twice, and he needs to be able to explain it if audited. Triage is a rules
 * problem. The model's job comes afterwards — explaining a case, drafting the client
 * conversation — not deciding who lands in which bucket.
 */

import book from "@/data/broker-book.json";
import { ALL_PLANS, getPlan, filterPlans, type Plan } from "./plans";
import { plansKeepingAll } from "./providers";

/**
 * Client records store doctors as "Dr. Reddy (cardiology)". The provider lookup
 * wants a bare name, so strip the specialty note before querying.
 */
function providerQueries(client: Client): string[] {
  return client.doctors.map((d) => d.replace(/\s*\(.*\)\s*$/, "").trim()).filter(Boolean);
}

export const BOOK_META = book.meta;

export type Client = {
  id: string;
  name: string;
  age: number;
  zip: string;
  currentPlanId: string;
  hasMedicaid: boolean;
  takesPrescriptions: boolean;
  medicationCount: number;
  chronicConditions: string[];
  preferredNetwork: string;
  doctors: string[];
  lastContact: string;
  phone?: string;
  bestTimeToCall?: string;
  email?: string;
};

export const CLIENTS = book.clients as Client[];
const DISCONTINUED = new Set(book.meta.discontinuedPlanIds);

export type Triage = "clear_port" | "needs_review" | "no_options" | "unaffected";

/**
 * A change row separates two things that are easy to conflate:
 *
 *   movement — which way the NUMBER went
 *   impact   — whether that is GOOD OR BAD for the client
 *
 * For most fields these agree: premiums, deductibles and copays going down is both
 * a decrease and an improvement. Part B giveback inverts it — the plan pays part of
 * the client's Part B premium, so a SMALLER number is WORSE for them.
 *
 * Collapsing these into one field produced a genuinely misleading row: giveback
 * falling from $117 to $94 was correctly flagged as worse, but rendered with an up
 * arrow beside a number that had gone down. Keeping them separate lets the arrow
 * follow the number and the colour carry the judgement.
 */
export type ChangeRow = {
  label: string;
  from: string;
  to: string;
  /** Drives colour. */
  impact: "better" | "worse" | "same";
  /** Drives the arrow. "none" for non-numeric fields, where an arrow is meaningless. */
  movement: "up" | "down" | "same" | "none";
  /** Plain language, for rows where the number alone could mislead. */
  note?: string;
};

export type ClientAssessment = {
  client: Client;
  currentPlan: Plan | undefined;
  triage: Triage;
  /** One line Tony can read aloud without interpreting anything. */
  headline: string;
  recommended?: Plan;
  alternatives: Plan[];
  changes: ChangeRow[];
  /** Why this landed in this bucket — the audit trail. */
  reasoning: string[];
  blockers: string[];
  /** undefined when the client named no providers to check. */
  providersKept?: boolean;
  providersDropped: string[];
};

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString()}`;
}

function movementOf(from: number, to: number): ChangeRow["movement"] {
  if (to === from) return "same";
  return to > from ? "up" : "down";
}

/** For costs — premium, deductible, copay, out-of-pocket — lower is better. */
function costRow(label: string, from: number, to: number): ChangeRow {
  return {
    label,
    from: money(from),
    to: money(to),
    impact: to === from ? "same" : to < from ? "better" : "worse",
    movement: movementOf(from, to),
  };
}

/**
 * Part B giveback is the one inverted field: the plan pays part of the client's Part B
 * premium, so a SMALLER number means LESS money back — worse for them, even though
 * the figure has gone down. Spelled out in the note, because a dollar amount falling
 * reads as good news to almost everyone.
 */
function givebackRow(from: number, to: number): ChangeRow {
  const fmt = (n: number) => (n > 0 ? `${money(n)}/mo` : "None");
  const delta = Math.abs(to - from);

  let note: string | undefined;
  if (to < from) note = `${money(delta)}/mo less back toward their Part B premium`;
  else if (to > from) note = `${money(delta)}/mo more back toward their Part B premium`;

  return {
    label: "Part B giveback",
    from: fmt(from),
    to: fmt(to),
    // Higher giveback is better — the impact is the reverse of the movement.
    impact: to === from ? "same" : to > from ? "better" : "worse",
    movement: movementOf(from, to),
    note,
  };
}

/**
 * Score how well a replacement plan preserves what the client already had.
 * Lower is better. Weightings reflect what actually causes a client to churn or
 * complain — losing drug coverage is catastrophic, a $5 copay change is noise.
 */
function disruptionScore(client: Client, current: Plan, candidate: Plan): number {
  let score = 0;

  // Losing needed drug coverage is disqualifying, not merely bad.
  if (client.takesPrescriptions && !candidate.hasPartD) return Number.POSITIVE_INFINITY;

  // Network change means the client may lose providers — the most common complaint.
  if (candidate.networkType !== current.networkType) score += 40;

  score += Math.abs(candidate.monthlyPremium - current.monthlyPremium) * 2;
  score += Math.abs(candidate.specialistCopay - current.specialistCopay) * 0.8;
  score += Math.abs(candidate.maxOutOfPocket - current.maxOutOfPocket) / 500;

  const curRx = current.rxDeductible ?? 0;
  const newRx = candidate.rxDeductible ?? 0;
  score += Math.abs(newRx - curRx) / 50;

  // A giveback the client currently enjoys and would lose is felt directly.
  if ((current.partBGiveback ?? 0) > 0 && (candidate.partBGiveback ?? 0) === 0) score += 25;

  return score;
}

/**
 * Row-by-row comparison between the ending plan and any candidate.
 *
 * Exported so the UI can recompute against an alternative when the broker clicks one —
 * comparing every option against the same baseline is the whole point of showing
 * alternatives at all.
 */
export function buildChanges(current: Plan, candidate: Plan): ChangeRow[] {
  return [
    costRow("Monthly premium", current.monthlyPremium, candidate.monthlyPremium),
    costRow("Max out-of-pocket", current.maxOutOfPocket, candidate.maxOutOfPocket),
    costRow("Specialist copay", current.specialistCopay, candidate.specialistCopay),
    costRow("Medical deductible", current.medicalDeductible, candidate.medicalDeductible),
    costRow("Drug deductible", current.rxDeductible ?? 0, candidate.rxDeductible ?? 0),
    {
      label: "Network type",
      from: current.networkType,
      to: candidate.networkType,
      impact: candidate.networkType === current.networkType ? "same" : "worse",
      // Not a quantity — an arrow here would imply a magnitude that doesn't exist.
      movement: "none",
      note:
        candidate.networkType === current.networkType
          ? undefined
          : "Different network — confirm their providers are covered",
    },
    givebackRow(current.partBGiveback ?? 0, candidate.partBGiveback ?? 0),
  ];
}

/** Plain-language one-liner on how a candidate compares to the recommended plan. */
export function compareToRecommended(recommended: Plan, other: Plan): string {
  const bits: string[] = [];
  const d = (a: number, b: number) => b - a;

  const prem = d(recommended.monthlyPremium, other.monthlyPremium);
  if (prem !== 0) bits.push(`${money(Math.abs(prem))}/mo ${prem > 0 ? "more" : "less"} premium`);

  const spec = d(recommended.specialistCopay, other.specialistCopay);
  if (spec !== 0) bits.push(`${money(Math.abs(spec))} ${spec > 0 ? "higher" : "lower"} specialist copay`);

  const med = d(recommended.medicalDeductible, other.medicalDeductible);
  if (med !== 0) bits.push(`${money(Math.abs(med))} ${med > 0 ? "higher" : "lower"} medical deductible`);

  const give = d(recommended.partBGiveback ?? 0, other.partBGiveback ?? 0);
  if (give !== 0) bits.push(`${money(Math.abs(give))}/mo ${give > 0 ? "more" : "less"} giveback`);

  if (other.networkType !== recommended.networkType) bits.push(`${other.networkType} network`);

  return bits.length ? bits.join(" · ") : "Materially equivalent";
}

export function assessClient(client: Client): ClientAssessment {
  const currentPlan = getPlan(client.currentPlanId);
  const reasoning: string[] = [];
  const blockers: string[] = [];

  if (!DISCONTINUED.has(client.currentPlanId)) {
    return {
      client,
      currentPlan,
      triage: "unaffected",
      headline: "Plan continues in 2027 — no action needed",
      alternatives: [],
      changes: [],
      reasoning: ["Current plan is not on the discontinued list"],
      blockers: [],
      providersDropped: [],
    };
  }

  reasoning.push(`Current plan ${client.currentPlanId} is being discontinued`);

  /**
   * Service area is checked before anything else.
   *
   * This is the bucket that matters most commercially and gets designed away most
   * often: a client who has moved out of the counties where plans are offered has
   * no path back, and is a guaranteed loss unless the agent knows early enough to
   * place them elsewhere. Surfacing it beats discovering it in December.
   */
  if (client.zip !== "28270") {
    blockers.push(`Now lives in ${client.zip} — outside the counties covered in this market`);
    return {
      client,
      currentPlan,
      triage: "no_options",
      headline: "Moved out of the service area — no in-market option",
      alternatives: [],
      changes: [],
      reasoning: [...reasoning, "Service area check failed before plan matching"],
      blockers,
      providersDropped: [],
    };
  }

  const { eligible } = filterPlans({
    hasMedicaid: client.hasMedicaid,
    chronicConditions: client.chronicConditions,
    needsDrugCoverage: client.takesPrescriptions,
  });

  // Never recommend the plan that's going away.
  const available = eligible.filter((p) => !DISCONTINUED.has(p.planId));

  if (client.takesPrescriptions) reasoning.push("Requires drug coverage — medical-only plans excluded");
  if (!client.hasMedicaid) reasoning.push("No Medicaid — Dual Special Needs Plans excluded");
  if (client.hasMedicaid) reasoning.push("Has Medicaid — D-SNP options included");

  if (available.length === 0) {
    if (client.hasMedicaid) {
      blockers.push("No remaining D-SNP in this county after the exits");
    } else {
      blockers.push("No eligible plan matches this client's requirements");
    }
    return {
      client,
      currentPlan,
      triage: "no_options",
      headline: "No eligible replacement — needs a conversation",
      alternatives: [],
      changes: [],
      reasoning,
      blockers,
      providersDropped: [],
    };
  }

  /**
   * Provider retention dominates ranking.
   *
   * Before the network lookup existed, plans were ranked on cost and network type
   * alone — which could put a plan that drops a nine-year cardiologist above one that
   * keeps them, purely on a $5 copay difference. For most people that ordering is
   * simply wrong: losing the specialist is the outcome they were trying to avoid.
   */
  const queries = providerQueries(client);
  const retention = new Map<string, string[]>(); // planId -> providers it would drop
  if (queries.length > 0) {
    for (const row of plansKeepingAll(queries, available.map((p) => p.planId))) {
      retention.set(row.planId, row.missing);
    }
    reasoning.push(`${queries.length} named provider(s) checked against every candidate plan`);
  }

  const dropped = (planId: string) => retention.get(planId) ?? [];

  const ranked = currentPlan
    ? [...available].sort((a, b) => {
        // Any plan that keeps every named provider outranks any plan that doesn't.
        const aDrops = dropped(a.planId).length;
        const bDrops = dropped(b.planId).length;
        if (aDrops !== bDrops) return aDrops - bDrops;
        return disruptionScore(client, currentPlan, a) - disruptionScore(client, currentPlan, b);
      })
    : available;

  const best = ranked[0];
  const score = currentPlan ? disruptionScore(client, currentPlan, best) : 0;
  const bestDrops = dropped(best.planId);

  if (queries.length > 0) {
    if (bestDrops.length === 0) reasoning.push("Recommended plan keeps every named provider");
    else reasoning.push(`Recommended plan would drop: ${bestDrops.join(", ")}`);
  }

  const changes: ChangeRow[] = currentPlan ? buildChanges(currentPlan, best) : [];

  const networkChanges = currentPlan && best.networkType !== currentPlan.networkType;
  const premiumJump = currentPlan && best.monthlyPremium - currentPlan.monthlyPremium > 20;

  if (networkChanges) reasoning.push(`Network changes ${currentPlan!.networkType} → ${best.networkType} — provider access may change`);
  if (premiumJump) reasoning.push("Premium increases by more than $20/month");
  if (client.doctors.length > 0) {
    reasoning.push(`${client.doctors.length} named provider(s) — network status not verified in this prototype`);
  }

  // A plan that drops a named provider is never a clean port, whatever the numbers say.
  const clean = score < 30 && !networkChanges && !premiumJump && bestDrops.length === 0;

  // Say what was actually checked. "Confirm providers first" was misleading once the
  // network lookup existed — by this point they have been checked.
  const providerNote =
    queries.length === 0
      ? "no named providers on file"
      : bestDrops.length === 0
        ? `keeps ${queries.join(" and ")}`
        : `drops ${bestDrops.join(" and ")}`;

  const headline = clean
    ? `Clean match — ${best.name}`
    : bestDrops.length > 0
      ? `Best available option ${providerNote}`
      : networkChanges
        ? `Network changes to ${best.networkType}, but ${providerNote}`
        : `Material cost change — ${providerNote}`;

  return {
    client,
    currentPlan,
    triage: clean ? "clear_port" : "needs_review",
    headline,
    recommended: best,
    alternatives: ranked.slice(1, 4),
    changes,
    reasoning,
    blockers,
    providersKept: queries.length > 0 ? bestDrops.length === 0 : undefined,
    providersDropped: bestDrops,
  };
}

export function assessBook() {
  const assessments = CLIENTS.map(assessClient);
  return {
    assessments,
    groups: {
      clear_port: assessments.filter((a) => a.triage === "clear_port"),
      needs_review: assessments.filter((a) => a.triage === "needs_review"),
      no_options: assessments.filter((a) => a.triage === "no_options"),
      unaffected: assessments.filter((a) => a.triage === "unaffected"),
    },
    totals: {
      clients: assessments.length,
      affected: assessments.filter((a) => a.triage !== "unaffected").length,
      plansInMarket: ALL_PLANS.length,
    },
  };
}

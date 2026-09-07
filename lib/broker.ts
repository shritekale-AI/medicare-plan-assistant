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
};

export const CLIENTS = book.clients as Client[];
const DISCONTINUED = new Set(book.meta.discontinuedPlanIds);

export type Triage = "clear_port" | "needs_review" | "no_options" | "unaffected";

export type ChangeRow = {
  label: string;
  from: string;
  to: string;
  /** better = improves for the client, worse = costs them, same = unchanged */
  direction: "better" | "worse" | "same";
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
};

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString()}`;
}

/** Lower is better for every field compared here. */
function direction(from: number, to: number): ChangeRow["direction"] {
  if (to === from) return "same";
  return to < from ? "better" : "worse";
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
    };
  }

  const ranked = currentPlan
    ? [...available].sort((a, b) => disruptionScore(client, currentPlan, a) - disruptionScore(client, currentPlan, b))
    : available;

  const best = ranked[0];
  const score = currentPlan ? disruptionScore(client, currentPlan, best) : 0;

  const changes: ChangeRow[] = currentPlan
    ? [
        {
          label: "Monthly premium",
          from: money(currentPlan.monthlyPremium),
          to: money(best.monthlyPremium),
          direction: direction(currentPlan.monthlyPremium, best.monthlyPremium),
        },
        {
          label: "Max out-of-pocket",
          from: money(currentPlan.maxOutOfPocket),
          to: money(best.maxOutOfPocket),
          direction: direction(currentPlan.maxOutOfPocket, best.maxOutOfPocket),
        },
        {
          label: "Specialist copay",
          from: money(currentPlan.specialistCopay),
          to: money(best.specialistCopay),
          direction: direction(currentPlan.specialistCopay, best.specialistCopay),
        },
        {
          label: "Medical deductible",
          from: money(currentPlan.medicalDeductible),
          to: money(best.medicalDeductible),
          direction: direction(currentPlan.medicalDeductible, best.medicalDeductible),
        },
        {
          label: "Drug deductible",
          from: money(currentPlan.rxDeductible),
          to: money(best.rxDeductible),
          direction: direction(currentPlan.rxDeductible ?? 0, best.rxDeductible ?? 0),
        },
        {
          label: "Network type",
          from: currentPlan.networkType,
          to: best.networkType,
          direction: best.networkType === currentPlan.networkType ? "same" : "worse",
        },
        {
          label: "Part B giveback",
          from: currentPlan.partBGiveback ? `${money(currentPlan.partBGiveback)}/mo` : "None",
          to: best.partBGiveback ? `${money(best.partBGiveback)}/mo` : "None",
          direction: direction(-(currentPlan.partBGiveback ?? 0), -(best.partBGiveback ?? 0)),
        },
      ]
    : [];

  const networkChanges = currentPlan && best.networkType !== currentPlan.networkType;
  const premiumJump = currentPlan && best.monthlyPremium - currentPlan.monthlyPremium > 20;

  if (networkChanges) reasoning.push(`Network changes ${currentPlan!.networkType} → ${best.networkType} — provider access may change`);
  if (premiumJump) reasoning.push("Premium increases by more than $20/month");
  if (client.doctors.length > 0) {
    reasoning.push(`${client.doctors.length} named provider(s) — network status not verified in this prototype`);
  }

  const clean = score < 30 && !networkChanges && !premiumJump;

  return {
    client,
    currentPlan,
    triage: clean ? "clear_port" : "needs_review",
    headline: clean
      ? `Clean match — ${best.name}`
      : networkChanges
        ? `Network changes to ${best.networkType} — confirm providers first`
        : "Material cost change — worth a call",
    recommended: best,
    alternatives: ranked.slice(1, 4),
    changes,
    reasoning,
    blockers,
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

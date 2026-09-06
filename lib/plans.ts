/**
 * Structured plan query layer.
 *
 * WHY THIS EXISTS SEPARATELY FROM RETRIEVAL:
 * Premiums, deductibles, copays and out-of-pocket maximums are numbers in tables.
 * Semantic retrieval over 300-page PDFs will confidently return the *wrong plan's*
 * figures — the single most likely way a plan-comparison demo fails in front of an
 * audience. So anything numeric or comparative is answered deterministically here,
 * and only genuinely prose-shaped questions ("am I covered while travelling?") go
 * to the retrieval layer.
 *
 * This split is the core architectural decision of the prototype.
 */

import raw from "@/data/plans-28270.json";

export type Plan = {
  planId: string;
  docId: string;
  name: string;
  networkType: "HMO" | "PPO" | "PFFS" | "Regional PPO";
  planTypeLabel: string;
  snpType: "D-SNP" | "C-SNP" | null;
  hasPartD: boolean;
  coverageLabel: string;
  monthlyPremium: number;
  monthlyPremiumMax: number;
  maxOutOfPocket: number;
  partBGiveback: number | null;
  pcpCopay: number;
  specialistCopay: number;
  specialistCopayMax?: number;
  medicalDeductible: number;
  rxDeductible: number | null;
  rxDeductibleMax?: number;
  rxDeductibleTiers: string | null;
  flags: string[];
  requiresMedicaid: boolean;
  requiresChronicCondition: boolean;
  qualifyingConditions?: string[];
};

export const PLAN_META = raw.meta;
export const ALL_PLANS = raw.plans as Plan[];

export function getPlan(planId: string): Plan | undefined {
  return ALL_PLANS.find((p) => p.planId.toLowerCase() === planId.toLowerCase());
}

export type PlanFilter = {
  /** Exclude D-SNP plans unless the person actually has Medicaid. */
  hasMedicaid?: boolean;
  /** Exclude C-SNP plans unless a qualifying condition is present. */
  chronicConditions?: string[];
  networkType?: Plan["networkType"] | "any";
  needsDrugCoverage?: boolean;
  maxMonthlyPremium?: number;
};

/**
 * Filter to plans a person can actually enrol in.
 *
 * Deliberately conservative: a plan is excluded when it *requires* something the
 * person doesn't have. Showing an ineligible plan and letting someone fall for it
 * is worse than showing fewer options.
 */
export function filterPlans(filter: PlanFilter): { eligible: Plan[]; excluded: { plan: Plan; reason: string }[] } {
  const eligible: Plan[] = [];
  const excluded: { plan: Plan; reason: string }[] = [];

  for (const plan of ALL_PLANS) {
    if (plan.requiresMedicaid && filter.hasMedicaid === false) {
      excluded.push({ plan, reason: "Requires Medicaid as well as Medicare (Dual Special Needs Plan)" });
      continue;
    }
    if (plan.requiresChronicCondition) {
      const has = (filter.chronicConditions ?? []).some((c) =>
        (plan.qualifyingConditions ?? []).some((q) => q.toLowerCase().includes(c.toLowerCase()))
      );
      if (!has) {
        excluded.push({
          plan,
          reason: `Requires a qualifying condition (${(plan.qualifyingConditions ?? []).join(", ")}) confirmed by a doctor`,
        });
        continue;
      }
    }
    if (filter.needsDrugCoverage && !plan.hasPartD) {
      excluded.push({ plan, reason: "Does not include prescription drug coverage" });
      continue;
    }
    if (filter.networkType && filter.networkType !== "any" && plan.networkType !== filter.networkType) {
      excluded.push({ plan, reason: `Not a ${filter.networkType} plan` });
      continue;
    }
    if (filter.maxMonthlyPremium !== undefined && plan.monthlyPremium > filter.maxMonthlyPremium) {
      excluded.push({ plan, reason: `Premium above $${filter.maxMonthlyPremium}/month` });
      continue;
    }
    eligible.push(plan);
  }

  return { eligible, excluded };
}

/**
 * Rough annual out-of-pocket estimate for comparison purposes only.
 *
 * Intentionally simple and clearly labelled as an estimate. A real cost model needs
 * the full benefit grid and drug tier placement; presenting a precise-looking number
 * that is quietly wrong would be worse than presenting an obviously rough one.
 */
export function estimateAnnualCost(
  plan: Plan,
  usage: { pcpVisits?: number; specialistVisits?: number }
): { premium: number; visits: number; givebackCredit: number; total: number; note: string } {
  const pcp = usage.pcpVisits ?? 0;
  const spec = usage.specialistVisits ?? 0;

  const premium = plan.monthlyPremium * 12;
  const visits = pcp * plan.pcpCopay + spec * plan.specialistCopay;
  const givebackCredit = (plan.partBGiveback ?? 0) * 12;
  const total = premium + visits - givebackCredit;

  return {
    premium,
    visits,
    givebackCredit,
    total,
    note: "Estimate covering premium, routine visit copays, and any Part B giveback. Excludes drug costs, deductibles, and other services.",
  };
}

/** Compact shape for putting plans into a model prompt without blowing up tokens. */
export function summarisePlan(plan: Plan): string {
  const parts = [
    `${plan.planId} — ${plan.name}`,
    `type: ${plan.planTypeLabel}`,
    `premium: $${plan.monthlyPremium}${plan.monthlyPremiumMax !== plan.monthlyPremium ? `–$${plan.monthlyPremiumMax}` : ""}/mo`,
    `max out-of-pocket: $${plan.maxOutOfPocket.toLocaleString()}`,
    `primary care: $${plan.pcpCopay}`,
    `specialist: $${plan.specialistCopay}${plan.specialistCopayMax ? `–$${plan.specialistCopayMax}` : ""}`,
    `medical deductible: $${plan.medicalDeductible}`,
  ];
  if (plan.hasPartD) parts.push(`drug deductible: $${plan.rxDeductible}`);
  else parts.push("no drug coverage");
  if (plan.partBGiveback) parts.push(`Part B giveback: up to $${plan.partBGiveback}/mo`);
  if (plan.snpType) parts.push(`${plan.snpType}`);
  return parts.join(" | ");
}

export function documentUrls(plan: Plan) {
  const base = "https://www.humana-medicare.com/BenefitSummary/2026PDFs";
  return {
    summaryOfBenefits: `${base}/${plan.docId}SB26.pdf`,
    evidenceOfCoverage: `${base}/${plan.docId}EOC26.pdf`,
  };
}

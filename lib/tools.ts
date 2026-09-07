/**
 * Tool definitions and executors for the plan assistant agent.
 *
 * DESIGN PRINCIPLE — the model decides *what to ask* and *how to explain*.
 * It never decides what is *true*. Every fact below comes from a deterministic
 * function over public plan data or from cited retrieval. Nothing about benefits,
 * costs, or eligibility is left to the model's own knowledge.
 *
 * These same definitions are exposed over MCP (see mcp-server/) so a second client
 * — a broker-facing surface — consumes identical capabilities. One capability
 * layer, multiple experiences.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { runEligibilityGates, type EligibilityInput } from "./eligibility";
import {
  ALL_PLANS,
  filterPlans,
  getPlan,
  estimateAnnualCost,
  summarisePlan,
  documentUrls,
  PLAN_META,
} from "./plans";
import { searchPlanDocuments } from "./retrieval";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "check_eligibility",
    description:
      "Run deterministic Medicare eligibility checks: service area, Medicare entitlement, enrollment window, and Special Needs Plan qualification. Call this EARLY, as soon as you know the ZIP code and roughly who you are speaking to. Call it again as you learn more. It returns per-gate pass/fail/unknown with plain-language explanations. If a gate fails, tell the person clearly and explain what it means for them — never hide a failure.",
    input_schema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "5-digit ZIP code" },
        age: { type: "number" },
        hasPartA: { type: "boolean", description: "Has Medicare Part A" },
        hasPartB: { type: "boolean", description: "Has Medicare Part B" },
        hasMedicaid: {
          type: "boolean",
          description:
            "Has Medicaid in addition to Medicare. Infer from plain-language answers such as 'the state helps pay my premiums'.",
        },
        chronicConditions: {
          type: "array",
          items: { type: "string" },
          description: "Ongoing conditions, e.g. ['diabetes']",
        },
        planNonRenewed: {
          type: "boolean",
          description: "Their current plan is being discontinued — opens a Special Enrollment Period",
        },
        recentMove: { type: "boolean" },
        birthMonth: { type: "number", description: "1-12, for Initial Enrollment Period timing" },
      },
      required: [],
    },
  },
  {
    name: "search_plans",
    description:
      "Find plans the person can actually enrol in. Returns eligible plans AND the plans that were excluded with the reason why. Always mention notable exclusions rather than letting plans silently disappear — a person who is told 'that one needs Medicaid, which you don't have' trusts the process more than one who simply sees fewer options.",
    input_schema: {
      type: "object",
      properties: {
        hasMedicaid: { type: "boolean" },
        chronicConditions: { type: "array", items: { type: "string" } },
        networkType: {
          type: "string",
          enum: ["HMO", "PPO", "PFFS", "Regional PPO", "any"],
          description: "HMO is usually cheaper but requires staying in network; PPO allows out-of-network at higher cost",
        },
        needsDrugCoverage: {
          type: "boolean",
          description:
            "REQUIRED to be true whenever the person has mentioned taking any prescription medication. Several plans in this dataset are medical-only with no Part D coverage; returning one to someone who takes medication is a materially harmful error. Do not omit this.",
        },
        maxMonthlyPremium: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "get_plan_details",
    description: "Full structured detail for one specific plan, including links to its official Summary of Benefits and Evidence of Coverage.",
    input_schema: {
      type: "object",
      properties: { planId: { type: "string", description: "e.g. 'H1036-318'" } },
      required: ["planId"],
    },
  },
  {
    name: "compare_plans",
    description:
      "Side-by-side comparison of 2-4 plans on the fields people actually decide on. Use this rather than describing plans one at a time when someone is choosing between options.",
    input_schema: {
      type: "object",
      properties: {
        planIds: { type: "array", items: { type: "string" }, description: "2 to 4 plan IDs" },
      },
      required: ["planIds"],
    },
  },
  {
    name: "estimate_annual_cost",
    description:
      "Rough annual out-of-pocket estimate for a plan given expected visits. Always present the result as an estimate and say what it excludes — never imply precision the model does not have.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string" },
        pcpVisits: { type: "number", description: "Expected primary care visits per year" },
        specialistVisits: { type: "number", description: "Expected specialist visits per year" },
      },
      required: ["planId"],
    },
  },
  {
    name: "search_plan_documents",
    description:
      "Search the official Summary of Benefits and Evidence of Coverage text for a specific plan. Use for questions whose answers live in prose rather than in the benefit table — travel coverage, referral rules, prior authorization, extra benefits, exclusions. ALWAYS cite the returned source in your answer. If nothing relevant comes back, say you could not find it and offer a human — never fill the gap from memory.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Restricts search to this plan's documents. Required — never mix plans." },
        query: { type: "string", description: "The question, in retrieval-friendly terms" },
      },
      required: ["planId", "query"],
    },
  },
  {
    name: "create_handoff_summary",
    description:
      "Build a structured summary to hand to a licensed Humana advocate when the person wants to speak to a human, or when a decision needs a licensed recommendation. Call this whenever they express hesitation, ask to talk to someone, or reach the point of enrolling.",
    input_schema: {
      type: "object",
      properties: {
        situation: { type: "string", description: "Why they are shopping, in one or two sentences" },
        mustHaves: { type: "array", items: { type: "string" }, description: "Doctors, drugs, budget constraints" },
        plansConsidered: { type: "array", items: { type: "string" }, description: "Plan IDs discussed" },
        plansRuledOut: { type: "array", items: { type: "string" }, description: "Plan IDs ruled out, with reasons" },
        openQuestion: { type: "string", description: "What they still need answered" },
      },
      required: ["situation"],
    },
  },
];

export async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "check_eligibility": {
      const gates = runEligibilityGates(input as EligibilityInput);
      return { gates, checkedAt: new Date().toISOString() };
    }

    case "search_plans": {
      const { eligible, excluded } = filterPlans(input as Parameters<typeof filterPlans>[0]);
      return {
        totalInZip: PLAN_META.totalPlansInZip,
        capturedInDataset: ALL_PLANS.length,
        eligibleCount: eligible.length,
        eligible: eligible.map((p) => ({ ...p, summary: summarisePlan(p) })),
        excluded: excluded.map((e) => ({ planId: e.plan.planId, name: e.plan.name, reason: e.reason })),
        datasetNote: PLAN_META.captureNote,
      };
    }

    case "get_plan_details": {
      const plan = getPlan(input.planId as string);
      if (!plan) return { error: `No plan found with ID ${input.planId}` };
      return { ...plan, summary: summarisePlan(plan), documents: documentUrls(plan) };
    }

    case "compare_plans": {
      const ids = (input.planIds as string[]) ?? [];
      const plans = ids.map((id) => getPlan(id)).filter(Boolean);
      if (plans.length === 0) return { error: "No matching plans found" };
      return {
        comparison: plans.map((p) => ({
          planId: p!.planId,
          name: p!.name,
          type: p!.planTypeLabel,
          monthlyPremium: p!.monthlyPremium,
          maxOutOfPocket: p!.maxOutOfPocket,
          pcpCopay: p!.pcpCopay,
          specialistCopay: p!.specialistCopay,
          medicalDeductible: p!.medicalDeductible,
          rxDeductible: p!.rxDeductible,
          partBGiveback: p!.partBGiveback,
          hasPartD: p!.hasPartD,
        })),
      };
    }

    case "estimate_annual_cost": {
      const plan = getPlan(input.planId as string);
      if (!plan) return { error: `No plan found with ID ${input.planId}` };
      return {
        planId: plan.planId,
        ...estimateAnnualCost(plan, {
          pcpVisits: input.pcpVisits as number | undefined,
          specialistVisits: input.specialistVisits as number | undefined,
        }),
      };
    }

    case "search_plan_documents": {
      return await searchPlanDocuments(input.planId as string, input.query as string);
    }

    case "create_handoff_summary": {
      return {
        handoff: {
          generatedAt: new Date().toISOString(),
          situation: input.situation,
          mustHaves: input.mustHaves ?? [],
          plansConsidered: input.plansConsidered ?? [],
          plansRuledOut: input.plansRuledOut ?? [],
          openQuestion: input.openQuestion ?? null,
          routeTo: "Licensed Humana member advocate",
          note: "In production this payload would be delivered into the advocate's desktop — the same context surface Agent Assist already consumes.",
        },
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

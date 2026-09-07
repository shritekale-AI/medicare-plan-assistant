import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { MODELS, GENERATION } from "@/lib/config";
import { CLIENTS, assessClient, BOOK_META } from "@/lib/broker";
import { TOOLS, executeTool } from "@/lib/tools";
import { documentUrls } from "@/lib/plans";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The AI half of the broker surface.
 *
 * WHERE THE LINE SITS, AND WHY:
 * triage — who lands in which bucket, which plans are eligible, what the cost deltas
 * are — is deterministic code. Tony is licensed and personally accountable, so the
 * same client must land in the same bucket every time and the reason must survive an
 * audit. A model must not be deciding that.
 *
 * But the deterministic layer stops exactly where Tony's real work begins. It can say
 * "specialist copay $35 → $40". It cannot say whether the new plan keeps the
 * cardiologist this client has seen for nine years, what the out-of-area rules mean
 * for someone who visits family in Ohio, or what to actually SAY on the phone. Those
 * answers live in ~200 pages of prose per plan, and reading them is the 30–40 minutes
 * per client that this is meant to remove.
 *
 * So: rules decide what is TRUE. The model reads the documents, explains what the
 * change means for THIS person, and drafts the conversation — every claim cited.
 * Same split as the member-facing assistant, applied to a different job.
 */

const BRIEF_SYSTEM = `You are briefing a licensed insurance broker on one client whose Medicare Advantage plan is being discontinued.

Your reader is a professional. Be direct and concise — no reassurance, no hedging, no restating what he can already see in the comparison table. He has sixty of these to get through.

You are given deterministic facts: the client's profile, their ending plan, the recommended replacement, the alternatives considered, and the computed cost changes. Those are settled — do not re-derive or dispute them.

Your job is what the numbers cannot tell him:
1. **Why this plan over the specific alternatives.** Name the alternative and the tradeoff. "H5525-050 has a lower specialist copay but a $250 medical deductible she doesn't have today" beats "this plan is a good balance."
2. **What actually changes for THIS client**, given what you know about them — their medications, their doctors, their conditions. Not generic plan differences.
3. **What he should say on the call.** One or two sentences he can use as-is.
4. **What he must verify before placing.** Be specific and honest about what this tool cannot confirm.

Use search_plan_documents for anything about coverage rules, referrals, travel, prior authorization, or extra benefits — and cite the document and page. If the documents do not answer something, say so plainly. Never fill a gap from general knowledge.

If the client has named providers, CHECK THEM with check_provider_network against both the recommended plan and the alternatives before writing anything. Whether a plan keeps their doctors usually outweighs every cost difference, and a plan that drops a long-standing specialist is not a clean match no matter what the numbers say. Report what you find, and note that network status must be re-confirmed at enrollment.

CRITICAL BOUNDARY: you are informing a licensed professional's recommendation, not making one. Never write "you should place her in X." Write what the differences are and what they mean. He decides.

Respond in this exact structure, using these headings:

**Bottom line**
One sentence.

**Why this over the alternatives**
2–4 sentences naming specific alternative plan IDs and the tradeoff against each.

**What changes for this client**
2–4 sentences tied to their actual profile. Cite documents where relevant.

**What to say**
One or two sentences in plain language, addressed to the client.

**Verify before placing**
2–3 concrete items.`;

/**
 * Email drafting carries a constraint the briefing does not.
 *
 * A briefing is internal — Tony reading about his own client. An EMAIL is an outbound
 * communication to a Medicare beneficiary about plan options, which CMS treats as
 * regulated marketing. So the draft deliberately avoids the things that would require
 * filing: comparative benefit claims, cost promises, and anything resembling a
 * recommendation. It exists to open a conversation, not to sell inside the inbox.
 *
 * The licensed agent reviews, edits, and sends it under his own name. He owns it.
 */
const EMAIL_SYSTEM = `You are drafting an email for a licensed insurance broker to send to one of his clients whose Medicare Advantage plan is being discontinued.

The client is a Medicare beneficiary, typically in their late sixties or seventies. Write for them, not for the broker.

Tone: warm, brief, calm. This letter may be the first they hear that something is changing, and the natural reaction is alarm. Lead with the fact that this is manageable and that he is already on it.

HARD CONSTRAINTS — an email to a Medicare beneficiary about plan options is regulated marketing communication:
- Do NOT recommend a plan or say which is best.
- Do NOT make comparative benefit claims ("better coverage", "you'll save money").
- Do NOT quote specific premiums, copays, or deductibles. Those belong in a conversation where he can explain them and answer questions.
- Do NOT promise their doctors will be covered. He verifies that on the call.
- Do NOT include any medical detail, diagnosis, or medication information. Email is not a secure channel and there is no reason to put it there.
- Do NOT create urgency beyond the real deadline.

DO:
- Say plainly that their current plan is ending and they'll need to choose something else.
- Say he has already looked at the options available to them.
- Give the real deadline (December 7).
- Ask for a short call, and offer their stated preferred time of day if you're given one.
- Sign off as the broker by first name.

Keep it under 150 words. Short paragraphs — this may be read on a phone.

Output format, exactly:
Subject: <subject line>

<body>

Nothing else. No preamble, no notes.`;

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "not_configured", message: "ANTHROPIC_API_KEY is not set." },
      { status: 503 }
    );
  }

  let body: { clientId?: string; mode?: "briefing" | "email" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }
  const mode = body.mode === "email" ? "email" : "briefing";

  const client = CLIENTS.find((c) => c.id === body.clientId);
  if (!client) {
    return NextResponse.json({ error: "not_found", message: "Unknown client." }, { status: 404 });
  }

  const assessment = assessClient(client);
  const anthropic = new Anthropic({ apiKey });

  // Hand the model the deterministic findings as settled facts, not as something to
  // recompute. It reasons about meaning; the rules engine owns the truth.
  const facts = {
    client: {
      name: client.name,
      age: client.age,
      medications: client.medicationCount,
      doctors: client.doctors,
      chronicConditions: client.chronicConditions,
      hasMedicaid: client.hasMedicaid,
      currentNetwork: client.preferredNetwork,
    },
    triage: assessment.triage,
    endingPlan: assessment.currentPlan
      ? { id: assessment.currentPlan.planId, name: assessment.currentPlan.name }
      : null,
    recommended: assessment.recommended
      ? {
          id: assessment.recommended.planId,
          name: assessment.recommended.name,
          premium: assessment.recommended.monthlyPremium,
          specialistCopay: assessment.recommended.specialistCopay,
          medicalDeductible: assessment.recommended.medicalDeductible,
          rxDeductible: assessment.recommended.rxDeductible,
          maxOutOfPocket: assessment.recommended.maxOutOfPocket,
          networkType: assessment.recommended.networkType,
          partBGiveback: assessment.recommended.partBGiveback,
        }
      : null,
    alternativesConsidered: assessment.alternatives.map((p) => ({
      id: p.planId,
      name: p.name,
      premium: p.monthlyPremium,
      specialistCopay: p.specialistCopay,
      medicalDeductible: p.medicalDeductible,
      rxDeductible: p.rxDeductible,
      maxOutOfPocket: p.maxOutOfPocket,
      networkType: p.networkType,
      partBGiveback: p.partBGiveback,
    })),
    computedChanges: assessment.changes,
    rulesEngineReasoning: assessment.reasoning,
    blockers: assessment.blockers,
  };

  // Document retrieval and provider lookups only — the model must not re-run
  // eligibility or plan search, which the rules engine already settled.
  const briefTools = TOOLS.filter((t) =>
    ["search_plan_documents", "check_provider_network", "find_plans_keeping_providers"].includes(t.name)
  );

  // The email draft needs no tools: it deliberately contains no benefit or cost
  // detail, so there is nothing to look up and no citation to attach.
  const activeTools = mode === "email" ? [] : briefTools;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        mode === "email"
          ? `Draft the email. Broker's first name: ${BOOK_META.broker.name}. Client's first name: ${client.name.split(" ")[0]}. Preferred time of day: ${client.bestTimeToCall ?? "not stated"}.`
          : `Brief me on this client.\n\n${JSON.stringify(facts, null, 2)}`,
    },
  ];

  const citations: { planId: string; document: string; page: number }[] = [];

  try {
    for (let turn = 0; turn < GENERATION.maxTurns; turn++) {
      const response = await anthropic.messages.create({
        model: MODELS.primary,
        max_tokens: 1400,
        system: mode === "email" ? EMAIL_SYSTEM : BRIEF_SYSTEM,
        ...(activeTools.length > 0 ? { tools: activeTools } : {}),
        messages,
      });

      if (response.stop_reason !== "tool_use") {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

        if (mode === "email") {
          const match = text.match(/^Subject:\s*(.+?)\n+([\s\S]+)$/);
          return NextResponse.json({
            mode,
            subject: match ? match[1].trim() : "Your Medicare plan for 2027",
            body: match ? match[2].trim() : text,
            to: client.email ?? null,
            complianceNote:
              "Draft only. An email to a Medicare beneficiary about plan options is regulated marketing communication — review, edit, and send it under your own name.",
          });
        }

        return NextResponse.json({
          mode,
          brief: text,
          citations,
          documents: assessment.recommended ? documentUrls(assessment.recommended) : null,
          endingDocuments: assessment.currentPlan ? documentUrls(assessment.currentPlan) : null,
        });
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input as Record<string, unknown>);
        const hits = (result as { hits?: { citation: { planId: string; document: string; page: number } }[] }).hits ?? [];
        for (const h of hits) citations.push(h.citation);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: results });
    }

    return NextResponse.json({ brief: "Briefing took too many steps.", citations });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "upstream", message: `Could not generate briefing: ${message}` },
      { status: 502 }
    );
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { TOOLS, executeTool } from "@/lib/tools";
import { PLAN_META } from "@/lib/plans";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The agent loop.
 *
 * The API key is read server-side only and never reaches the browser — the whole
 * reason this route exists rather than calling the model from the client.
 */

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 8;

const SYSTEM_PROMPT = `You are the Humana Plan Assistant — a prototype that helps people understand and compare Medicare Advantage plans.

## What you are
You are an AI assistant, and you say so if anyone asks. You are NOT a licensed insurance agent. You help people *understand* their options; a licensed human makes the actual recommendation and completes any enrollment.

## The person you are usually talking to
Often someone in their late 60s whose plan is being discontinued, or an adult child researching on a parent's behalf. They are stressed, working against a deadline, and afraid of making a mistake they cannot undo. Treat that seriously.

## How to talk
- Short, warm, conversational. Two or three sentences, then stop and let them respond.
- Answers may be read aloud by a screen reader or spoken back — so write for the ear. No bullet-point walls, no markdown tables in speech-shaped replies.
- Never use jargon without immediately explaining it. "Maximum out-of-pocket" becomes "the most you'd pay in a year before the plan covers everything."
- One question at a time. Never interrogate.
- Currency in plain form: "forty dollars a month", not "$40.00/mo", when the tone is conversational.

## How to be correct
- EVERY fact about a plan — cost, coverage, eligibility — comes from a tool. Never from memory. You do not know Humana's plan details independently; you look them up.
- Call \`check_eligibility\` as soon as you have a ZIP code and a rough picture. Call it again as you learn more.
- When an eligibility gate FAILS, say so plainly and explain what it means. Never hide it. "You don't qualify for that type of plan, and here's why" builds more trust than silently showing fewer options.
- When \`search_plans\` returns excluded plans, mention the notable exclusions and why.
- For questions about coverage rules, travel, referrals, or prior authorization, use \`search_plan_documents\` and CITE what comes back — name the document and page.
- If a document search returns nothing, say you could not find it and offer a human. Do NOT fill the gap from general knowledge.

## Boundaries — these matter
- You do NOT tell someone which plan is "best" for them. You lay out how the options differ against what they told you matters, and let them decide. If pressed for a recommendation, explain that a licensed advocate can make an actual recommendation, and offer to connect them.
- You do NOT give medical advice. If asked whether they should see a doctor or change a medication, decline warmly and point them to their doctor.
- You do NOT collect Social Security numbers, Medicare numbers, bank details, or full dates of birth. If someone offers one, tell them not to share it here.
- You do NOT complete enrollment. You can assemble an application for review, but a licensed human confirms and submits it.

## When to hand off
Call \`create_handoff_summary\` when they ask to speak to someone, express real hesitation, want a recommendation, or are ready to enroll. Tell them what you are passing along so they know they will not have to repeat themselves.

## Context
Today is ${new Date().toISOString().slice(0, 10)}. This prototype covers ${PLAN_META.plansCaptured} Medicare Advantage plans in ${PLAN_META.county} County, ${PLAN_META.state} (ZIP ${PLAN_META.zip}) for plan year ${PLAN_META.planYear}. Medicare's Annual Enrollment Period runs October 15 to December 7.

If someone asks about a different area, explain plainly that this prototype only holds data for ZIP 28270.`;

type IncomingMessage = { role: "user" | "assistant"; content: string };
type TraceEntry = { tool: string; input: unknown; summary: string };

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "not_configured",
        message:
          "ANTHROPIC_API_KEY is not set. Add it to .env.local (local) or the Vercel project's environment variables (deployed).",
      },
      { status: 503 }
    );
  }

  let body: { messages?: IncomingMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON body." }, { status: 400 });
  }

  const incoming = body.messages ?? [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "bad_request", message: "No messages provided." }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = incoming.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const trace: TraceEntry[] = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1600,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason !== "tool_use") {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

        return NextResponse.json({
          reply: text || "Sorry — I didn't manage to put together a reply. Could you try asking again?",
          trace,
        });
      }

      // Execute every requested tool, then feed results back.
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input as Record<string, unknown>);
        trace.push({
          tool: block.name,
          input: block.input,
          summary: summariseResult(block.name, result),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return NextResponse.json({
      reply:
        "That turned into more steps than I expected. Could you narrow the question down a little, or would you like me to connect you with a licensed advocate?",
      trace,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isCredit = /credit|billing|quota|insufficient/i.test(message);
    return NextResponse.json(
      {
        error: isCredit ? "quota" : "upstream",
        message: isCredit
          ? "This demo has reached its usage limit. The prototype is capped deliberately."
          : `Something went wrong reaching the model: ${message}`,
      },
      { status: 502 }
    );
  }
}

/** Short human-readable summary of a tool result, for the visible trace panel. */
function summariseResult(tool: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (tool) {
    case "check_eligibility": {
      const gates = (r.gates ?? []) as { status: string }[];
      const pass = gates.filter((g) => g.status === "pass").length;
      const fail = gates.filter((g) => g.status === "fail").length;
      const unknown = gates.filter((g) => g.status === "unknown").length;
      return `${pass} passed, ${fail} failed, ${unknown} still unknown`;
    }
    case "search_plans":
      return `${r.eligibleCount ?? 0} eligible of ${r.capturedInDataset ?? 0} indexed`;
    case "search_plan_documents": {
      const hits = (r.hits ?? []) as unknown[];
      return hits.length > 0 ? `${hits.length} passages retrieved` : "no matching passages";
    }
    case "compare_plans": {
      const c = (r.comparison ?? []) as unknown[];
      return `${c.length} plans compared`;
    }
    case "estimate_annual_cost":
      return `estimated $${r.total ?? "?"} per year`;
    case "get_plan_details":
      return typeof r.name === "string" ? r.name : "plan detail";
    case "create_handoff_summary":
      return "handoff summary prepared";
    default:
      return "done";
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { TOOLS, executeTool } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { identityContext, resolveIdentity } from "@/lib/members";
import { MODELS, GENERATION, LIMITS } from "@/lib/config";
import { compactConversation } from "@/lib/summarize";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The agent loop.
 *
 * The API key is read server-side only and never reaches the browser — the whole
 * reason this route exists rather than calling the model from the client.
 */

const MAX_TURNS = GENERATION.maxTurns;
const MAX_MESSAGE_CHARS = LIMITS.maxMessageChars;
const MAX_MESSAGES = LIMITS.maxMessages;

/**
 * Per-IP rate limiting, in memory.
 *
 * Deliberately simple and honestly limited: serverless instances don't share memory,
 * so this throttles a casual burst rather than a determined attacker. The real
 * protection for a public demo is the workspace-scoped spend cap on the API key —
 * a hard financial ceiling that holds regardless of how many instances exist.
 * Production would use a shared store (Redis / Vercel KV).
 */
const rateBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) ?? []).filter((t) => now - t < LIMITS.rateWindowMs);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // crude unbounded-growth guard
  return hits.length > LIMITS.rateMaxRequests;
}


type IncomingImage = { mediaType: string; data: string };
type IncomingMessage = { role: "user" | "assistant"; content: string; image?: IncomingImage };

/** Opaque account token. The browser never sends a profile — only this. */
type IncomingBody = { messages?: IncomingMessage[]; identityToken?: string };

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
type TraceEntry = {
  tool: string;
  input: unknown;
  summary: string;
  /**
   * Retrieved passages, present only for document searches. Carried so groundedness
   * can be scored — checking not just THAT the assistant cited something, but whether
   * its claims actually follow from the text it retrieved. Not rendered in the UI.
   */
  evidence?: { text: string; page: number; document: string }[];
};

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

  let body: IncomingBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON body." }, { status: 400 });
  }

  // Identity is resolved HERE, from a token, against the server's own records — the
  // browser never supplies a profile. A client that could post its own plan, doctors
  // and medications would be a client that could put words in the account's mouth.
  // When there is no token the prompt requires the assistant to ask rather than assume.
  const identity = resolveIdentity(body.identityToken);
  const systemPrompt = identity
    ? `${SYSTEM_PROMPT}\n\n${identityContext(identity)}`
    : SYSTEM_PROMPT;

  const incoming = body.messages ?? [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "bad_request", message: "No messages provided." }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "That's a lot of questions at once — give it a minute and try again.",
      },
      { status: 429 }
    );
  }

  if (incoming.length > MAX_MESSAGES) {
    return NextResponse.json(
      {
        error: "too_long",
        message: "This conversation has got quite long. Please start a new one.",
      },
      { status: 400 }
    );
  }

  const oversized = incoming.find(
    (m) => typeof m.content !== "string" || m.content.length > MAX_MESSAGE_CHARS
  );
  if (oversized) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: `Please keep each message under ${MAX_MESSAGE_CHARS} characters.`,
      },
      { status: 400 }
    );
  }

  // Validate any attached images before they reach the model.
  for (const m of incoming) {
    if (!m.image) continue;
    if (!ALLOWED_IMAGE_TYPES.includes(m.image.mediaType)) {
      return NextResponse.json(
        { error: "bad_request", message: "Images must be JPEG, PNG, WebP, or GIF." },
        { status: 400 }
      );
    }
    // base64 inflates by ~4/3; compare against the decoded size.
    if ((m.image.data.length * 3) / 4 > LIMITS.maxImageBytes) {
      return NextResponse.json(
        { error: "too_large", message: "That image is too large. Please use one under 4MB." },
        { status: 400 }
      );
    }
  }

  const client = new Anthropic({ apiKey });

  // Compact older turns before building the request. Text only — an image is the
  // one thing a summary genuinely cannot carry forward, so images always sit in the
  // recent window or not at all.
  const textOnly = incoming.map((m) => ({ role: m.role, content: m.content }));
  const { messages: compacted, compacted: didCompact, summarised } =
    await compactConversation(client, textOnly);

  const messages: Anthropic.MessageParam[] = didCompact
    ? compacted.map((m) => ({ role: m.role, content: m.content }))
    : incoming.map((m) => {
        if (!m.image) return { role: m.role, content: m.content };
        return {
          role: m.role,
          content: [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: m.image.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                data: m.image.data,
              },
            },
            { type: "text" as const, text: m.content || "Here's the letter I received." },
          ],
        };
      });

  const trace: TraceEntry[] = [];
  if (didCompact) {
    trace.push({
      tool: "compact_conversation",
      input: { summarisedMessages: summarised, model: MODELS.fast },
      summary: `${summarised} earlier messages summarised to stay within context`,
    });
  }

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model: MODELS.primary,
        max_tokens: GENERATION.maxTokens,
        system: systemPrompt,
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
          ...(block.name === "search_plan_documents" ? { evidence: extractEvidence(result) } : {}),
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

/** Pull retrieved passages out of a document-search result for groundedness scoring. */
function extractEvidence(result: unknown): { text: string; page: number; document: string }[] {
  const hits = (result as { hits?: unknown[] }).hits ?? [];
  return hits.map((h) => {
    const hit = h as { text: string; citation: { page: number; document: string } };
    return {
      text: hit.text.replace(/<\/?retrieved_document>/g, "").trim(),
      page: hit.citation.page,
      document: hit.citation.document,
    };
  });
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
    case "check_provider_network": {
      if (r.found === false) return r.ambiguous ? "ambiguous name — asked to clarify" : "provider not found";
      const results = (r.results ?? []) as { inNetwork: boolean }[];
      const inCount = results.filter((x) => x.inNetwork).length;
      return `in network for ${inCount} of ${results.length} plans checked`;
    }
    case "find_plans_keeping_providers":
      return `${r.keepAllCount ?? 0} plan(s) keep every named provider`;
    case "create_handoff_summary":
      return "handoff summary prepared";
    case "compact_conversation":
      return "earlier turns summarised";
    default:
      return "done";
  }
}

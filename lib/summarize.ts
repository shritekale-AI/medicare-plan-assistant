import Anthropic from "@anthropic-ai/sdk";
import { MODELS, COMPACTION } from "./config";

/**
 * Conversation compaction — sliding window with a summarised tail.
 *
 * WHY THIS EXISTS:
 * the caregiver persona researches across two sittings and then has to justify the
 * choice to her mother and her brother. Simply truncating old messages would drop
 * exactly the reasoning she needs to defend. Summarising keeps the thread intact
 * while bounding token growth.
 *
 * WHY A SMALLER MODEL:
 * summarisation is a narrow, well-specified task, and nothing it produces is shown
 * to a member — it only ever re-enters the primary model's context. Routing it to a
 * faster model cuts cost and latency with no effect on answer quality.
 *
 * WHAT THE SUMMARY DELIBERATELY PRESERVES:
 * the facts that drive eligibility and plan matching. If compaction drops the fact
 * that someone takes four prescriptions, the assistant may later surface a
 * medical-only plan — a materially harmful error caused by a memory optimisation.
 * The prompt below is explicit about that risk.
 */

const SUMMARY_PROMPT = `You are compacting the earlier part of a Medicare plan-shopping conversation so it can be carried forward in limited context.

Write a compact factual summary. Preserve, without exception:
- Every personal fact affecting eligibility: age, ZIP code, Medicaid status, chronic conditions, military coverage, whether their plan is ending
- Every stated need: doctors they want to keep, number and names of medications, budget limits
- Plan IDs discussed, and whether each was ruled in or out AND why
- Any eligibility gate that failed and the reason
- Open questions they still have

Drop: pleasantries, restatements, and the assistant's explanatory prose.

Losing a fact here causes real harm downstream — if you drop that someone takes prescriptions, they may later be shown a plan with no drug coverage. When unsure whether a detail matters, keep it.

Reply with the summary only. No preamble.`;

export type SimpleMessage = { role: "user" | "assistant"; content: string };

/**
 * Returns messages ready to send: a summary of the older turns plus recent ones
 * verbatim. Below the trigger threshold, returns the input unchanged.
 */
export async function compactConversation(
  client: Anthropic,
  messages: SimpleMessage[]
): Promise<{ messages: SimpleMessage[]; compacted: boolean; summarised: number }> {
  if (messages.length <= COMPACTION.triggerAfterMessages) {
    return { messages, compacted: false, summarised: 0 };
  }

  const splitAt = messages.length - COMPACTION.keepRecentMessages;
  const older = messages.slice(0, splitAt);
  const recent = messages.slice(splitAt);

  const transcript = older
    .map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  try {
    const response = await client.messages.create({
      model: MODELS.fast,
      max_tokens: 700,
      system: SUMMARY_PROMPT,
      messages: [{ role: "user", content: transcript }],
    });

    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!summary) return { messages, compacted: false, summarised: 0 };

    return {
      messages: [
        {
          role: "user",
          content: `[Summary of earlier conversation]\n${summary}\n[End of summary — continue from here]`,
        },
        { role: "assistant", content: "Understood — I have the earlier context." },
        ...recent,
      ],
      compacted: true,
      summarised: older.length,
    };
  } catch {
    // Compaction is an optimisation, never a dependency. If it fails, carry on with
    // the full history — slower and more expensive, but nothing is lost.
    return { messages, compacted: false, summarised: 0 };
  }
}

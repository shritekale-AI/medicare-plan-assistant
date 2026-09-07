# MCP Server — the second surface

The same capability layer the web app uses, exposed over the Model Context Protocol so a different client can consume it.

## Why this exists

The proposal claims a **platform**, not a chatbot: one capability layer, many experiences. That's easy to assert on a slide. This makes it checkable.

These are the **identical** tool definitions and executors from `lib/tools.ts` that the member-facing web app calls. Nothing is re-implemented — if it were, the two surfaces would drift and the platform claim would quietly stop being true.

| Surface | Client | User | Shape of the interaction |
|---|---|---|---|
| Member | Web app | Linda (68) | Voice, short conversational answers, one question at a time |
| Caregiver | Web app | Amy (44) | Text, comparison tables, citations she can click |
| **Broker** | **MCP client** | **Tony (41)** | **Inside the agent he already works in** |

Tony doesn't want another portal to log into. He wants these capabilities in the tool that's already open while he's on the phone with a client. Same eligibility rules, same retrieval, same citations, same audit trail — different experience entirely.

## Running it

```bash
npx tsx mcp-server/server.ts
```

It speaks MCP over stdio. Register it with any MCP client — for Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "medicare-plan-assistant": {
      "command": "npx",
      "args": ["tsx", "mcp-server/server.ts"],
      "cwd": "/absolute/path/to/humana-plan-assistant"
    }
  }
}
```

## Tools exposed

All seven, unchanged from the web app:

| Tool | Purpose |
|---|---|
| `check_eligibility` | Deterministic gates — service area, entitlement, enrollment window, SNP qualification |
| `search_plans` | Eligible plans plus **exclusions with reasons** |
| `get_plan_details` | One plan in full, with document links |
| `compare_plans` | Side-by-side on the fields people decide on |
| `estimate_annual_cost` | Rough annual estimate, labelled as an estimate |
| `search_plan_documents` | Retrieval over official documents, cited to page |
| `create_handoff_summary` | Structured context for a licensed advocate |

## What doesn't change across surfaces

The boundaries come from regulation, not from the interface, so they're identical here:

- **No enrollment capability exists.** Not restricted — absent
- **Plan facts come only from tools**, never from model memory
- **Retrieval is hard-filtered by plan ID** before scoring, so one plan's benefits can never answer a question about another
- **These tools inform a recommendation; they don't make one.** The licensed human decides

The broker framing differs — Tony is licensed and accountable, so he needs speed and verifiability rather than gentle pacing — but what the system will and won't do is the same either way.

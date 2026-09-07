#!/usr/bin/env node
/**
 * MCP server — the same capability layer, exposed to a second client.
 *
 * WHY THIS EXISTS:
 * the pitch claims a *platform*, not a chatbot: one capability layer, many surfaces.
 * That claim is easy to put on a slide and hard to believe. This makes it checkable —
 * these are the identical tool definitions and executors the member-facing web app
 * consumes (`lib/tools.ts`), served over MCP so a completely different client can use
 * them.
 *
 * Concretely: the member surface is the web app. The BROKER surface is an MCP client
 * — Claude Desktop, or any agent the broker already works in. Tony doesn't want
 * another portal to log into; he wants these capabilities inside the tool he already
 * has open. Same eligibility rules, same retrieval, same citations, same audit trail.
 * Different experience.
 *
 * Nothing here re-implements logic. If it did, the two surfaces would drift, and the
 * platform claim would quietly become false.
 *
 * Run:  npx tsx mcp-server/server.ts
 * Wire into a client as a stdio server pointing at that command.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { TOOLS, executeTool } from "../lib/tools";
import { PLAN_META } from "../lib/plans";
import { corpusStats } from "../lib/retrieval";

const server = new Server(
  {
    name: "medicare-plan-assistant",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

/**
 * Guidance for whichever agent picks this up. The broker-facing framing differs from
 * the member-facing system prompt — Tony is licensed and accountable, so he needs
 * speed and verifiability rather than gentle pacing — but the hard boundaries are
 * identical, because they come from the same regulations.
 */
const SERVER_INSTRUCTIONS = `Medicare plan navigation for ${PLAN_META.county} County, ${PLAN_META.state} (ZIP ${PLAN_META.zip}), plan year ${PLAN_META.planYear}.

Intended for licensed agents and brokers resolving displaced clients quickly.

Rules that do not change regardless of who is asking:
- Every plan fact comes from these tools. Never answer benefit or cost questions from memory.
- Cite the document and page whenever you use search_plan_documents. The agent carries the liability and needs to verify.
- These tools inform a recommendation; they do not make one. The licensed human decides.
- No enrollment capability exists here by design.`;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await executeTool(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const corpus = corpusStats();

  // stderr, not stdout — stdout is the MCP protocol channel and anything written
  // there corrupts the stream.
  console.error(
    `medicare-plan-assistant MCP server\n` +
      `  ${TOOLS.length} tools | ${PLAN_META.plansCaptured} plans | ` +
      `${corpus.chunks} document chunks | corpus ${corpus.corpusVersion}\n` +
      `  ${SERVER_INSTRUCTIONS.split("\n")[0]}`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

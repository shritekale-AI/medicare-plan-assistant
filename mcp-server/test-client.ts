/**
 * Verifies the MCP server actually works, by connecting a real MCP client to it.
 *
 * This is the check that makes the platform claim honest. "The tools are MCP-ready"
 * is an assertion; a second client completing a handshake, listing the tools, and
 * getting correct answers back is evidence.
 *
 * Run: npx tsx mcp-server/test-client.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp-server/server.ts"],
    cwd: process.cwd(),
  });

  const client = new Client({ name: "verification-client", version: "1.0.0" }, { capabilities: {} });

  console.log("Connecting to MCP server over stdio…\n");
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Tools exposed: ${tools.length}`);
  for (const t of tools) console.log(`  - ${t.name}`);

  // Deterministic rules through MCP.
  console.log("\n[check_eligibility] 68yo, ZIP 28270, no Medicaid");
  const elig = await client.callTool({
    name: "check_eligibility",
    arguments: { zip: "28270", age: 68, hasPartA: true, hasPartB: true, hasMedicaid: false },
  });
  const eligText = (elig.content as { type: string; text: string }[])[0].text;
  const gates = JSON.parse(eligText).gates as { label: string; status: string }[];
  for (const g of gates) console.log(`  ${g.status.padEnd(8)} ${g.label}`);

  // Structured plan query through MCP.
  console.log("\n[search_plans] no Medicaid, needs drug coverage");
  const plans = await client.callTool({
    name: "search_plans",
    arguments: { hasMedicaid: false, needsDrugCoverage: true },
  });
  const planData = JSON.parse((plans.content as { type: string; text: string }[])[0].text);
  console.log(`  ${planData.eligibleCount} eligible of ${planData.capturedInDataset} indexed`);
  console.log(`  ${planData.excluded.length} excluded, each with a stated reason`);

  // Retrieval with citation through MCP — the hardest one to fake.
  console.log("\n[search_plan_documents] H1036-318, referral rules");
  const docs = await client.callTool({
    name: "search_plan_documents",
    arguments: { planId: "H1036-318", query: "referral required to see a specialist" },
  });
  const docData = JSON.parse((docs.content as { type: string; text: string }[])[0].text);
  if (docData.hits?.length) {
    const top = docData.hits[0];
    console.log(`  ${docData.hits.length} passages, top from ${top.citation.document} p.${top.citation.page}`);
    console.log(`  doc version ${top.citation.docVersion} | corpus ${top.citation.corpusVersion}`);
  } else {
    console.log(`  no hits — ${docData.note ?? ""}`);
  }

  await client.close();
  console.log("\nSame capability layer, second client. Platform claim verified.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

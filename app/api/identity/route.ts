import { NextResponse } from "next/server";
import { publicSummary, resolveIdentity, signInOptions } from "@/lib/members";

export const runtime = "nodejs";

/** GET — who can be signed in as, for the simulated account picker. */
export async function GET() {
  return NextResponse.json(signInOptions());
}

/**
 * POST — exchange a token for the summary the UI is allowed to display.
 *
 * Only non-clinical fields come back: name, current plan, ZIP. The medication count
 * and provider list stay server-side and reach the model through the system prompt,
 * never through the browser. That split is not ceremony for a prototype with synthetic
 * data — it is the shape the real thing has to have, and building it the other way
 * round would mean rebuilding it later.
 */
export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  const identity = resolveIdentity(body.token);
  if (!identity) {
    return NextResponse.json(
      { error: "not_found", message: "That account could not be found." },
      { status: 404 }
    );
  }
  return NextResponse.json(publicSummary(identity));
}

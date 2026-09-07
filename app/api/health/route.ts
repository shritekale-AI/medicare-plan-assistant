import { NextResponse } from "next/server";
import { MODEL } from "@/lib/config";
import { corpusStats } from "@/lib/retrieval";
import { PLAN_META } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Deployment health and provenance.
 *
 * WHY THIS EXISTS:
 * "the deployment should be current" and "I can see that it is current" are different
 * claims, and only the second one is checkable before a demo. Vercel keeps serving the
 * last SUCCESSFUL build when a new one fails — so a broken push leaves the URL up and
 * quietly stale, which is the worst failure mode: everything looks fine.
 *
 * This endpoint reports the exact commit, corpus version, and model actually running,
 * so "is the link current?" is answered by looking rather than assuming.
 */
export async function GET() {
  const corpus = corpusStats();
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  return NextResponse.json(
    {
      status: "ok",
      deployment: {
        environment: process.env.VERCEL_ENV ?? "local",
        commit: sha ? sha.slice(0, 7) : "local",
        commitFull: sha,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        // Truncated: commit messages are author-controlled text and this response is public.
        commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0]?.slice(0, 100) ?? null,
        checkedAt: new Date().toISOString(),
      },
      model: MODEL,
      corpus: {
        indexed: corpus.indexed,
        version: corpus.corpusVersion,
        chunks: corpus.chunks,
        plans: corpus.plans,
        ingestedAt: corpus.ingestedAt,
      },
      planData: {
        zip: PLAN_META.zip,
        county: PLAN_META.county,
        planYear: PLAN_META.planYear,
        plansCaptured: PLAN_META.plansCaptured,
      },
      // Reports whether the key is configured — never any part of its value.
      apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

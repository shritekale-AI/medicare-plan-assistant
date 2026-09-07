/**
 * Provider network lookup.
 *
 * WHY THIS IS A STRUCTURED LOOKUP AND NOT RETRIEVAL:
 * network status is a fact about a tuple — (provider, plan, date) → in or out. It is
 * not prose, and it must never be answered by semantic search. A retrieval system
 * asked "is Dr. Reddy in this plan" will confidently surface a *different* Reddy, or
 * the right one under the wrong plan, and sound completely certain doing it. The
 * consequence is a member enrolled in a plan that drops the specialist they have
 * seen for nine years, which they discover when they are already sick.
 *
 * Same reasoning as premiums living in `plans.ts` rather than the document corpus:
 * if the answer is a value in a table, look it up.
 *
 * DATA IS SYNTHETIC — see data/provider-network.json. Humana serves provider data
 * through a live lookup, not a downloadable directory, so there is nothing public to
 * ingest. This exists to make the integration seam explicit and the demo honest about
 * where the real API attaches.
 */

import network from "@/data/provider-network.json";

export const NETWORK_META = network.meta;

export type Provider = {
  npi: string;
  name: string;
  searchNames: string[];
  specialty: string;
  practice: string;
  city: string;
  acceptingNewPatients: boolean;
  inNetworkPlans: string[];
};

export const PROVIDERS = network.providers as Provider[];

/**
 * Match a provider by loose name. People say "Dr. Reddy", "my cardiologist Reddy",
 * or "Anjali Reddy" — the lookup has to tolerate all of it while staying exact enough
 * that two different providers never silently collapse into one.
 */
export function findProviders(query: string): Provider[] {
  const q = query.toLowerCase().trim().replace(/^dr\.?\s+/, "");
  if (q.length < 2) return [];

  return PROVIDERS.filter((p) =>
    p.searchNames.some((n) => n.includes(q) || q.includes(n)) ||
    p.name.toLowerCase().includes(q)
  );
}

export type NetworkResult = {
  provider: { npi: string; name: string; specialty: string; practice: string; city: string };
  planId: string;
  inNetwork: boolean;
  acceptingNewPatients: boolean;
  lastNetworkUpdate: string;
  caveat: string;
};

const CAVEAT =
  "Network status changes continuously and must be re-confirmed at enrollment. This lookup uses synthetic demonstration data, not Humana's live directory.";

/** Check one named provider against one or more plans. */
export function checkNetwork(
  providerQuery: string,
  planIds: string[]
): { matched: NetworkResult[]; ambiguous: string[]; notFound: boolean } {
  const matches = findProviders(providerQuery);

  if (matches.length === 0) return { matched: [], ambiguous: [], notFound: true };

  // More than one match is reported rather than guessed. Picking the "probably right"
  // provider is exactly how someone ends up with the wrong doctor confirmed.
  if (matches.length > 1) {
    return { matched: [], ambiguous: matches.map((m) => `${m.name} (${m.specialty}, ${m.practice})`), notFound: false };
  }

  const p = matches[0];
  return {
    matched: planIds.map((planId) => ({
      provider: { npi: p.npi, name: p.name, specialty: p.specialty, practice: p.practice, city: p.city },
      planId,
      inNetwork: p.inNetworkPlans.includes(planId),
      acceptingNewPatients: p.acceptingNewPatients,
      lastNetworkUpdate: NETWORK_META.lastNetworkUpdate,
      caveat: CAVEAT,
    })),
    ambiguous: [],
    notFound: false,
  };
}

/** Which of the supplied plans keep every one of the named providers. */
export function plansKeepingAll(
  providerQueries: string[],
  planIds: string[]
): { planId: string; keepsAll: boolean; missing: string[] }[] {
  return planIds.map((planId) => {
    const missing: string[] = [];
    for (const q of providerQueries) {
      const matches = findProviders(q);
      if (matches.length !== 1) {
        missing.push(`${q} (not resolved)`);
        continue;
      }
      if (!matches[0].inNetworkPlans.includes(planId)) missing.push(matches[0].name);
    }
    return { planId, keepsAll: missing.length === 0, missing };
  });
}

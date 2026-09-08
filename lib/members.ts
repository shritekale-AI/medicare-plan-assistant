/**
 * Member identity and account context.
 *
 * WHAT THIS FIXES
 * The member surface originally had no identity step. The assistant discussed "your
 * plan" without ever having established which plan that was — it read as working only
 * because the demo starter volunteered a ZIP and an age, and because a language model
 * will happily keep a conversation going over a fact it does not have. A reviewer
 * asked "how did the app know who Linda is and what plan she has?" and the honest
 * answer was that it didn't.
 *
 * That is a product defect, not a prompt defect. A plan-selection assistant that
 * cannot say what someone is enrolled in today cannot tell them what changes — and
 * "what changes for me" is the entire question.
 *
 * TWO PATHS, DELIBERATELY
 * Signing in resolves identity from the account. Not signing in is equally valid —
 * someone newly eligible has never had an account, and a caregiver may be helping
 * before access is delegated — and in that case the assistant must ASK. What it must
 * never do is assume.
 *
 * WHERE THE PHI LINE IS
 * Everything here is synthetic. In production this is the moment protected health
 * information enters the system: an authenticated session returning enrollment,
 * providers and pharmacy history. The rest of the architecture was chosen so that this
 * is the ONLY place it enters — plan documents are public, eligibility rules are
 * public, and the retrieval corpus contains nothing about any individual.
 */

import fs from "fs";
import path from "path";

export type MemberRecord = {
  id: string;
  name: string;
  firstName: string;
  age: number;
  zip: string;
  currentPlanId: string | null;
  planEnding: boolean;
  hasPartA: boolean;
  hasPartB: boolean;
  hasMedicaid: boolean;
  takesPrescriptions: boolean;
  medicationCount: number;
  doctorsOnFile: string[];
  memberSince: string | null;
  note?: string;
};

export type Delegate = {
  id: string;
  name: string;
  firstName: string;
  actsFor: string;
  relationship: string;
  authorization: string;
  note?: string;
};

type MemberFile = {
  meta: Record<string, unknown>;
  members: MemberRecord[];
  delegates: Delegate[];
};

let cache: MemberFile | null = null;

function load(): MemberFile {
  if (cache) return cache;
  try {
    const p = path.join(process.cwd(), "data", "members.json");
    cache = JSON.parse(fs.readFileSync(p, "utf-8")) as MemberFile;
  } catch {
    cache = { meta: {}, members: [], delegates: [] };
  }
  return cache;
}

export function getMember(id: string): MemberRecord | null {
  return load().members.find((m) => m.id === id) ?? null;
}

export function getDelegate(id: string): Delegate | null {
  return load().delegates.find((d) => d.id === id) ?? null;
}

/** Who the caller is signed in as, and whose record they are entitled to read. */
export type ResolvedIdentity = {
  member: MemberRecord;
  /** Set when a caregiver is acting for the member rather than the member themselves. */
  actingAs?: Delegate;
};

/**
 * Resolve an identity token to a record.
 *
 * Deliberately server-side and by ID only. The browser never sends a profile — it
 * sends a token, and the record is looked up here. A client that could post its own
 * medication list and doctors would be a client that could put words in the account's
 * mouth, and in production that is the difference between an account lookup and an
 * unauthenticated claim.
 */
export function resolveIdentity(token: string | undefined): ResolvedIdentity | null {
  if (!token) return null;

  const direct = getMember(token);
  if (direct) return { member: direct };

  const delegate = getDelegate(token);
  if (delegate) {
    const member = getMember(delegate.actsFor);
    if (member) return { member, actingAs: delegate };
  }
  return null;
}

/**
 * The established-facts block injected into the system prompt.
 *
 * Phrased as things ALREADY KNOWN rather than things to confirm, because the failure
 * mode on the other side is an assistant that re-interrogates someone about details
 * their own account already holds — which is exactly the form-filling this product
 * exists to replace.
 */
export function identityContext(identity: ResolvedIdentity): string {
  const m = identity.member;
  const who = identity.actingAs
    ? `${identity.actingAs.firstName} ${identity.actingAs.name.split(" ").slice(1).join(" ")} is signed in as ${m.firstName}'s ${identity.actingAs.relationship} and ${identity.actingAs.authorization.toLowerCase()}. Address ${identity.actingAs.firstName} directly, and refer to ${m.firstName} in the third person. Say early and once that you are looking at ${m.firstName}'s account.`
    : `${m.firstName} is signed in to their own account.`;

  const lines = [
    `## Who you are talking to — established from the signed-in account, do not ask again`,
    who,
    ``,
    `- Name: ${m.name} (member ${m.id})`,
    `- Age: ${m.age}`,
    `- ZIP: ${m.zip}`,
    m.currentPlanId
      ? `- Currently enrolled in: ${m.currentPlanId}${m.planEnding ? " — THIS PLAN IS BEING DISCONTINUED for the coming plan year, which opens a Special Enrollment Period" : ""}`
      : `- Not currently enrolled in a Humana plan`,
    `- Medicare Part A: ${m.hasPartA ? "yes" : "no"} · Part B: ${m.hasPartB ? "yes" : "no"}`,
    `- Medicaid: ${m.hasMedicaid ? "yes" : "no"}`,
    m.takesPrescriptions
      ? `- Takes ${m.medicationCount} prescription medication${m.medicationCount === 1 ? "" : "s"} — you MUST pass needsDrugCoverage: true to search_plans`
      : `- No prescriptions on file — still confirm this, people forget`,
    m.doctorsOnFile.length > 0
      ? `- Providers on file: ${m.doctorsOnFile.join(", ")} — check these with check_provider_network before discussing any plan`
      : `- No providers on file`,
    ``,
    `These came from the account, not from the conversation. Use them. Do not make ${identity.actingAs ? identity.actingAs.firstName : m.firstName} repeat them.`,
    `The pharmacy and provider records can be out of date, so confirm rather than interrogate: "I have Dr. Reddy and Dr. Ellis on file — is that still right?" is good; asking who their doctors are is not.`,
  ];
  return lines.join("\n");
}

/** Safe summary for the browser — no clinical detail beyond what the person can already see. */
export function publicSummary(identity: ResolvedIdentity) {
  const m = identity.member;
  return {
    memberId: m.id,
    name: m.name,
    firstName: m.firstName,
    currentPlanId: m.currentPlanId,
    planEnding: m.planEnding,
    zip: m.zip,
    actingAs: identity.actingAs
      ? { name: identity.actingAs.name, relationship: identity.actingAs.relationship }
      : null,
  };
}

/** Sign-in options for the simulated account picker. */
export function signInOptions() {
  const f = load();
  return {
    members: f.members
      .filter((m) => m.currentPlanId !== null)
      .map((m) => ({ token: m.id, label: m.name, sub: `Member since ${m.memberSince} · plan ${m.currentPlanId}` })),
    delegates: f.delegates.map((d) => {
      const m = getMember(d.actsFor);
      return { token: d.id, label: d.name, sub: `${d.relationship} of ${m?.name ?? d.actsFor} · ${d.authorization}` };
    }),
  };
}

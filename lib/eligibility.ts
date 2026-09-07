/**
 * Deterministic Medicare eligibility gates.
 *
 * Kept OUT of the language model on purpose. Eligibility is a rules problem with
 * legal consequences — it must be reproducible, auditable, and testable. The model
 * decides what to *ask* and how to *explain*; this module decides what is *true*.
 *
 * SIMPLIFICATION NOTICE: these encode the common cases of CMS enrollment-period and
 * SNP-qualification rules for a demonstration. Real rules carry many more exceptions
 * (institutionalization, ESRD transitions, employer-group timing, state-specific
 * Medicaid categories). Production use would require compliance review and a
 * versioned, testable rules service. Documented rather than hidden.
 */

export type EligibilityInput = {
  zip?: string;
  age?: number;
  hasPartA?: boolean;
  hasPartB?: boolean;
  hasMedicaid?: boolean;
  chronicConditions?: string[];
  /** Their current plan is being discontinued for the coming plan year. */
  planNonRenewed?: boolean;
  /** Permanent move outside the current plan's service area, within the last 2 months. */
  recentMove?: boolean;
  /** 1-12; used for Initial Enrollment Period math. */
  birthMonth?: number;
  /** Injectable for testing. */
  today?: Date;
};

export type GateStatus = "pass" | "fail" | "unknown";

export type GateResult = {
  gate: string;
  label: string;
  status: GateStatus;
  /** Plain language, written to be read aloud to a 68-year-old. */
  message: string;
  /** What to do about it when status is fail or unknown. */
  nextStep?: string;
  /** Regulatory basis, surfaced for auditability. */
  basis?: string;
};

/** Service areas present in this demonstration dataset. */
const SERVED_ZIPS: Record<string, { county: string; state: string }> = {
  "28270": { county: "Mecklenburg", state: "NC" },
};

const MONTH = (d: Date) => d.getMonth() + 1; // 1-12
const DAY = (d: Date) => d.getDate();

/** Annual Enrollment Period: Oct 15 - Dec 7 every year. */
export function inAEP(today: Date): boolean {
  const m = MONTH(today);
  const d = DAY(today);
  if (m === 10) return d >= 15;
  if (m === 11) return true;
  if (m === 12) return d <= 7;
  return false;
}

/** Medicare Advantage Open Enrollment Period: Jan 1 - Mar 31, for existing MA members. */
export function inMAOEP(today: Date): boolean {
  return MONTH(today) <= 3;
}

/**
 * Initial Enrollment Period: the 3 months before, the month of, and the 3 months
 * after the 65th birthday month — a 7-month window.
 */
export function inIEP(today: Date, age?: number, birthMonth?: number): boolean {
  if (age === undefined || birthMonth === undefined) return false;
  if (age < 64 || age > 66) return false;
  const diff = MONTH(today) - birthMonth;
  const wrapped = ((diff + 18) % 12) - 6; // normalise to -6..+5
  return wrapped >= -3 && wrapped <= 3;
}

/**
 * SEP for involuntary loss of coverage when a plan is non-renewed.
 * Commonly runs from notification through the end of February. Members may also
 * simply use AEP, which is the more usual path when the notice lands in October.
 */
export function inNonRenewalSEP(today: Date, planNonRenewed?: boolean): boolean {
  if (!planNonRenewed) return false;
  const m = MONTH(today);
  return m >= 10 || m <= 2;
}

export function runEligibilityGates(input: EligibilityInput): GateResult[] {
  const today = input.today ?? new Date();
  const results: GateResult[] = [];

  // ---- Gate 1: service area -------------------------------------------------
  if (!input.zip) {
    results.push({
      gate: "service_area",
      label: "Service area",
      status: "unknown",
      message: "I need your ZIP code to see which plans are offered where you live.",
      nextStep: "Ask for the ZIP code.",
    });
  } else if (SERVED_ZIPS[input.zip]) {
    const { county, state } = SERVED_ZIPS[input.zip];
    results.push({
      gate: "service_area",
      label: "Service area",
      status: "pass",
      message: `You're in ${county} County, ${state}. Plans there are available to you.`,
      basis: "Medicare Advantage plans are offered county by county.",
    });
  } else {
    results.push({
      gate: "service_area",
      label: "Service area",
      status: "fail",
      message: `This demonstration only covers ZIP 28270 (Mecklenburg County, NC). I don't have plan data for ${input.zip}.`,
      nextStep: "In production this would query the full national service-area table.",
    });
  }

  // ---- Gate 2: Medicare entitlement ----------------------------------------
  const ageKnown = input.age !== undefined;
  const partsKnown = input.hasPartA !== undefined && input.hasPartB !== undefined;

  if (!ageKnown) {
    results.push({
      gate: "medicare_entitlement",
      label: "Medicare entitlement",
      status: "unknown",
      message: "I need to know whether you already have Medicare Part A and Part B.",
      nextStep: "Ask about age and current Medicare coverage.",
    });
  } else if (partsKnown && (!input.hasPartA || !input.hasPartB)) {
    results.push({
      gate: "medicare_entitlement",
      label: "Medicare entitlement",
      status: "fail",
      message:
        "To join a Medicare Advantage plan you need both Part A and Part B. It looks like one of those is missing.",
      nextStep:
        "Enrol in the missing part through Social Security first — then a Medicare Advantage plan becomes available.",
      basis: "Medicare Advantage requires entitlement to Part A and enrollment in Part B.",
    });
  } else if (input.age! < 65) {
    results.push({
      gate: "medicare_entitlement",
      label: "Medicare entitlement",
      status: "unknown",
      message:
        "Under 65, Medicare eligibility usually depends on a qualifying disability or condition. That needs checking.",
      nextStep: "Confirm disability-based entitlement.",
    });
  } else {
    results.push({
      gate: "medicare_entitlement",
      label: "Medicare entitlement",
      status: "pass",
      message: "You have Medicare Part A and Part B, so Medicare Advantage plans are open to you.",
    });
  }

  // ---- Gate 3: enrollment period -------------------------------------------
  const windows: string[] = [];
  if (inAEP(today)) windows.push("the Annual Enrollment Period (Oct 15 – Dec 7)");
  if (inNonRenewalSEP(today, input.planNonRenewed))
    windows.push("a Special Enrollment Period because your plan is ending");
  if (inIEP(today, input.age, input.birthMonth))
    windows.push("your Initial Enrollment Period around turning 65");
  if (inMAOEP(today)) windows.push("the Medicare Advantage Open Enrollment Period (Jan 1 – Mar 31)");
  if (input.recentMove) windows.push("a Special Enrollment Period because you moved");

  if (windows.length > 0) {
    results.push({
      gate: "enrollment_period",
      label: "Enrollment window",
      status: "pass",
      message: `You can make a change right now — you're covered by ${windows[0]}.`,
      basis: windows.join("; "),
    });
  } else if (
    input.age !== undefined &&
    input.age >= 64 &&
    input.age <= 66 &&
    input.birthMonth === undefined
  ) {
    /**
     * Someone around 65 is very likely inside their Initial Enrollment Period — but
     * IEP is a seven-month window keyed to their birthday, so it cannot be evaluated
     * without a birth month.
     *
     * Reporting "fail" here would tell a first-time shopper they had missed a window
     * they are almost certainly inside. Missing information must read as UNKNOWN,
     * never as a negative finding. Surfaced by testing the newly-eligible persona.
     */
    results.push({
      gate: "enrollment_period",
      label: "Enrollment window",
      status: "unknown",
      message:
        "Around 65 there's usually a seven-month window to join — from three months before your birthday month through three months after. I need to know which month you turned 65 to check that.",
      nextStep: "Ask which month they turned (or turn) 65.",
      basis: "Initial Enrollment Period: 3 months before through 3 months after the 65th birthday month.",
    });
  } else {
    const daysToAEP = daysUntilAEP(today);
    results.push({
      gate: "enrollment_period",
      label: "Enrollment window",
      status: "fail",
      message: `Right now you're outside the windows when Medicare lets you switch plans. The Annual Enrollment Period opens October 15 — that's ${daysToAEP} days away.`,
      nextStep:
        "We can still compare plans today so you're ready. Certain life events — moving, losing coverage, or your plan ending — can also open a window sooner.",
      basis: "CMS enrollment periods: IEP, AEP, MA-OEP, and qualifying SEPs.",
    });
  }

  // ---- Gate 4: D-SNP (dual eligible) ---------------------------------------
  if (input.hasMedicaid === undefined) {
    results.push({
      gate: "dsnp_qualification",
      label: "Dual Special Needs Plans",
      status: "unknown",
      message: "Some plans are only for people who have both Medicare and Medicaid. I'd need to check that.",
      nextStep: "Ask whether the state helps pay their Medicare premiums or medical costs.",
    });
  } else if (input.hasMedicaid) {
    results.push({
      gate: "dsnp_qualification",
      label: "Dual Special Needs Plans",
      status: "pass",
      message:
        "Because you have Medicaid as well as Medicare, you qualify for Dual Special Needs Plans — these usually have lower costs.",
      basis: "D-SNP enrollment requires Medicare and Medicaid eligibility.",
    });
  } else {
    results.push({
      gate: "dsnp_qualification",
      label: "Dual Special Needs Plans",
      status: "fail",
      message: "Dual Special Needs Plans need Medicaid as well as Medicare, so those aren't options for you.",
      nextStep: "Excluded from the comparison. Worth rechecking if income or circumstances change.",
      basis: "D-SNP enrollment requires Medicare and Medicaid eligibility.",
    });
  }

  // ---- Gate 5: C-SNP (chronic condition) -----------------------------------
  const conditions = input.chronicConditions ?? [];
  if (conditions.length === 0) {
    results.push({
      gate: "csnp_qualification",
      label: "Chronic Condition Plans",
      status: "unknown",
      message:
        "Some plans are built for specific ongoing conditions, like diabetes or heart conditions.",
      nextStep: "Ask about ongoing conditions treated by a specialist.",
    });
  } else {
    results.push({
      gate: "csnp_qualification",
      label: "Chronic Condition Plans",
      status: "pass",
      message: `Because of your ${conditions.join(" and ")}, Chronic Condition Special Needs Plans may be available.`,
      nextStep:
        "These require your doctor to confirm the diagnosis on a short form before coverage starts.",
      basis: "C-SNP enrollment requires physician verification of a qualifying condition (VCC form).",
    });
  }

  return results;
}

function daysUntilAEP(today: Date): number {
  const year = today.getFullYear();
  let target = new Date(year, 9, 15); // Oct 15
  if (today > target) target = new Date(year + 1, 9, 15);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

/** True when every gate that blocks enrollment has passed. */
export function hasBlockingFailure(gates: GateResult[]): boolean {
  return gates.some(
    (g) =>
      g.status === "fail" &&
      ["service_area", "medicare_entitlement", "enrollment_period"].includes(g.gate)
  );
}

/**
 * Workshop (job) stage pipeline — single source of truth for the NestJS API
 * and the Next.js app.
 *
 * `Job.status` is a plain string in Postgres (deliberately no DB enum, so the
 * stage list can evolve without a migration); these helpers are what turn it
 * into a real state machine: applicable stages per job, coercion of legacy
 * labels, and the transition guards.
 *
 * Stages are sequential — the only adaptive rule is that “Diagnosis and
 * billing” is rendered only when the job carries a quote (the same rule the
 * stepper used when that stage was called “Quoted”).
 */

export const JOB_STAGES = [
  "Received",
  "Diagnosis and billing",
  "Approved",
  "Initial deposit",
  "In progress",
  "Quality check",
  "Final payment",
  "Vehicle collected",
] as const;

export type JobStage = (typeof JOB_STAGES)[number];

/** Stage omitted when the job has no quote (adaptive stepper). */
export const QUOTED_STAGE: JobStage = "Diagnosis and billing";

/** First stage a job lands on when it has no readable status. */
export const FIRST_STAGE: JobStage = "Received";

/**
 * Labels used by rows that predate a stage rename. They are never accepted as
 * input — `coerceJobStatus` maps them so existing records still render and
 * advance correctly.
 */
const LEGACY_STAGE_ALIASES: Record<string, JobStage> = {
  Quoted: "Diagnosis and billing",
  "In Progress": "In progress",
  QC: "Quality check",
  Delivered: "Vehicle collected",
};

/** Button label shown when moving *to* the given stage. */
const ADVANCE_LABELS: Record<string, string> = {
  Received: "Mark Received",
  "Diagnosis and billing": "Begin diagnosis",
  Approved: "Mark Approved",
  "Initial deposit": "Request deposit",
  "In progress": "Start Work",
  "Quality check": "Send to QC",
  "Final payment": "Request final payment",
  "Vehicle collected": "Mark Vehicle collected",
  // Cafe order stages share this label source.
  Preparing: "Start Preparing",
  Ready: "Mark Ready",
  Served: "Mark Served",
};

/** Payment comparison tolerance (mirrors `paymentStatusFromAmounts`). */
const MONEY_EPSILON = 1e-6;

export function isJobStage(value: string): value is JobStage {
  return (JOB_STAGES as readonly string[]).includes(value);
}

/**
 * Resolve a raw label (possibly written before a stage rename) to a stage.
 * Returns null for anything that isn't a known stage — callers decide whether
 * to fall back.
 */
export function normalizeJobStage(value: string): JobStage | null {
  const stage = LEGACY_STAGE_ALIASES[value.trim()] ?? value.trim();
  return isJobStage(stage) ? stage : null;
}

export function getApplicableStages(hasQuote: boolean): JobStage[] {
  if (hasQuote) return [...JOB_STAGES];
  return JOB_STAGES.filter((stage) => stage !== QUOTED_STAGE);
}

/**
 * Repair orphan statuses: legacy labels (Quoted/QC/Delivered/In Progress),
 * a quote stage on a job that no longer has a quote, and anything unknown.
 */
export function coerceJobStatus(current: string, hasQuote: boolean): JobStage {
  const stage = normalizeJobStage(current) ?? FIRST_STAGE;
  if (stage === QUOTED_STAGE && !hasQuote) return FIRST_STAGE;
  return stage;
}

export function getNextStage(
  current: string,
  hasQuote: boolean,
): JobStage | null {
  const stages = getApplicableStages(hasQuote);
  const effective = coerceJobStatus(current, hasQuote);
  const index = stages.indexOf(effective);
  if (index === -1 || index >= stages.length - 1) return null;
  return stages[index + 1] ?? null;
}

/** Label for the button that moves a job to `next` (null when finished). */
export function advanceLabelForStage(next: string | null): string {
  if (!next) return "Complete";
  return ADVANCE_LABELS[next] ?? `Mark ${next}`;
}

export function getAdvanceLabel(
  current: string,
  hasQuote: boolean,
): string | null {
  const next = getNextStage(current, hasQuote);
  if (!next) return null;
  return advanceLabelForStage(next);
}

export function isQcChecklistComplete(
  checklist: Record<string, boolean> | null | undefined,
): boolean {
  if (!checklist) return true;
  const values = Object.values(checklist);
  if (values.length === 0) return true;
  return values.every(Boolean);
}

/** Narrow a stored JSON value (Prisma `Json?`) to a QC checklist shape. */
export function toQcChecklist(value: unknown): Record<string, boolean> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, boolean>)
    : null;
}

/** Anything worth collecting (> 0) that we know about. */
function hasAmountDue(expectedAmount: number | null | undefined): boolean {
  if (expectedAmount == null) return false;
  const value = Number(expectedAmount);
  return Number.isFinite(value) && value > 0;
}

export type StageGateInput = {
  hasQuote: boolean;
  quoteAmount?: number | null;
  qcChecklist?: Record<string, boolean> | null;
  /**
   * Total the customer is expected to pay for this job — sale total when the
   * job has a commercial sale, otherwise the final invoice amount, otherwise
   * the quote. `null` means “we don't know”, which skips the payment gates so
   * a job can never be stranded on missing money data.
   */
  expectedAmount?: number | null;
  /** Non-return payments received against `expectedAmount`. */
  paidAmount?: number | null;
};

export type TransitionInput = StageGateInput & {
  from: string;
  to: JobStage;
};

/**
 * Guards for a single forward transition. Throws a human-readable Error so
 * callers can surface it as a 400.
 *
 * - into `Approved` (quote path): a quote amount must exist.
 * - into `Final payment`: the QC checklist must be complete.
 * - into `In progress`: the initial deposit must have been recorded.
 * - into `Vehicle collected`: the balance must be settled.
 */
export function assertTransition(input: TransitionInput): void {
  const { hasQuote, quoteAmount, qcChecklist, expectedAmount, paidAmount, to } =
    input;

  if (to === "Approved" && hasQuote) {
    if (quoteAmount == null || !Number.isFinite(Number(quoteAmount))) {
      throw new Error("Save a quote amount before marking Approved");
    }
  }

  if (to === "Final payment" && !isQcChecklistComplete(qcChecklist)) {
    throw new Error(
      "Complete the QC checklist before requesting final payment",
    );
  }

  if (to === "In progress" && hasAmountDue(expectedAmount)) {
    if (!(Number(paidAmount ?? 0) > 0)) {
      throw new Error("Record the initial deposit before starting work");
    }
  }

  if (to === "Vehicle collected" && hasAmountDue(expectedAmount)) {
    const paid = Number(paidAmount ?? 0);
    const expected = Number(expectedAmount);
    if (paid + MONEY_EPSILON < expected) {
      const remaining = expected - paid;
      throw new Error(
        `Collect the outstanding balance before marking the vehicle collected (₦${remaining.toLocaleString("en-NG")} due)`,
      );
    }
  }
}

export type AdvanceGuardInput = StageGateInput & {
  currentStatus: string;
};

/**
 * Validate advancing one step. Returns the next stage or throws.
 */
export function assertCanAdvance(input: AdvanceGuardInput): JobStage {
  const next = getNextStage(input.currentStatus, input.hasQuote);
  if (!next) {
    throw new Error("Job is already at the final stage");
  }
  assertTransition({ ...input, from: input.currentStatus, to: next });
  return next;
}

export type ReachGuardInput = AdvanceGuardInput & {
  requestedStatus: string;
};

/**
 * Validate jumping to an explicit stage (sales “Update job status” modal).
 * Every forward transition in between must pass its guard; moving backwards is
 * always allowed (those gates were already satisfied).
 * Returns the coerced requested stage or throws.
 */
export function assertCanReach(input: ReachGuardInput): JobStage {
  const { currentStatus, requestedStatus, hasQuote } = input;
  const stages = getApplicableStages(hasQuote);
  const requested = requestedStatus.trim();
  if (!isJobStage(requested) || !stages.includes(requested)) {
    throw new Error(
      `Invalid status “${requested}”. Allowed: ${stages.join(", ")}`,
    );
  }
  if (requested === currentStatus) return requested;

  const from = coerceJobStatus(currentStatus, hasQuote);
  const fromIndex = stages.indexOf(from);
  const toIndex = stages.indexOf(requested);
  if (fromIndex === -1 || toIndex === -1) return requested;

  for (let i = fromIndex + 1; i <= toIndex; i += 1) {
    const stage = stages[i];
    if (!stage) continue;
    assertTransition({ ...input, from: stages[i - 1] ?? from, to: stage });
  }
  return requested;
}

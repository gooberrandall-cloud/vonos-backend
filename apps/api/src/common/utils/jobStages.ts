const ALL_STAGES = [
  'Received',
  'Quoted',
  'Approved',
  'In Progress',
  'QC',
  'Delivered',
] as const;

export type JobStage = (typeof ALL_STAGES)[number];

export function isJobStage(value: string): value is JobStage {
  return (ALL_STAGES as readonly string[]).includes(value);
}

export function getApplicableStages(hasQuote: boolean): JobStage[] {
  if (hasQuote) return [...ALL_STAGES];
  return ALL_STAGES.filter((stage) => stage !== 'Quoted');
}

/**
 * Repair orphan statuses (e.g. job stuck on Quoted after hasQuote was turned off).
 */
export function coerceJobStatus(current: string, hasQuote: boolean): JobStage {
  if (current === 'Quoted' && !hasQuote) return 'Received';
  if (isJobStage(current)) return current;
  return 'Received';
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

export function getAdvanceLabel(
  current: string,
  hasQuote: boolean,
): string | null {
  const next = getNextStage(current, hasQuote);
  if (!next) return null;
  const labels: Record<JobStage, string> = {
    Received: 'Mark Received',
    Quoted: 'Send Quote',
    Approved: 'Mark Approved',
    'In Progress': 'Start Work',
    QC: 'Send to QC',
    Delivered: 'Mark Delivered',
  };
  return labels[next] ?? `Advance to ${next}`;
}

export function isQcChecklistComplete(
  checklist: Record<string, boolean> | null | undefined,
): boolean {
  if (!checklist) return true;
  const values = Object.values(checklist);
  if (values.length === 0) return true;
  return values.every(Boolean);
}

export type AdvanceGuardInput = {
  currentStatus: string;
  hasQuote: boolean;
  quoteAmount?: number | null;
  qcChecklist?: Record<string, boolean> | null;
};

/**
 * Validate whether the job may advance to the next applicable stage.
 * Returns the next stage or throws a descriptive Error message (for BadRequest).
 */
export function assertCanAdvance(input: AdvanceGuardInput): JobStage {
  const { currentStatus, hasQuote, quoteAmount, qcChecklist } = input;
  const next = getNextStage(currentStatus, hasQuote);
  if (!next) {
    throw new Error('Job is already at the final stage');
  }

  const effective = coerceJobStatus(currentStatus, hasQuote);

  // Quote path: must have an amount before leaving Quoted → Approved.
  if (next === 'Approved' && hasQuote) {
    if (quoteAmount == null || !Number.isFinite(Number(quoteAmount))) {
      throw new Error('Save a quote amount before marking Approved');
    }
  }

  if (next === 'Delivered' && !isQcChecklistComplete(qcChecklist)) {
    throw new Error('Complete the QC checklist before marking Delivered');
  }

  // effective unused except for clarity — keep for future gates
  void effective;

  return next;
}

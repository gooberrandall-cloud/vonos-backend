const ALL_STAGES = [
  'Received',
  'Quoted',
  'Approved',
  'In Progress',
  'QC',
  'Delivered',
] as const;

export type JobStage = (typeof ALL_STAGES)[number];

export function getApplicableStages(hasQuote: boolean): JobStage[] {
  if (hasQuote) return [...ALL_STAGES];
  return ALL_STAGES.filter((stage) => stage !== 'Quoted');
}

export function getNextStage(
  current: string,
  hasQuote: boolean,
): JobStage | null {
  const stages = getApplicableStages(hasQuote);
  const index = stages.indexOf(current as JobStage);
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

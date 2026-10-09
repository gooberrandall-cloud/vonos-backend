/**
 * Workshop stage stored on Sale.notes for VA/VP (sales act as jobs).
 */

import {
  coerceJobStatus,
  getApplicableStages,
  isJobStage,
  type JobStage,
} from './jobStages';

const JOB_STATUS_KEY = 'Job status';
const JOB_STATUS_LOG_KEY = 'Job status log';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readNoteLine(notes: string | null | undefined, label: string): string | null {
  if (!notes?.trim()) return null;
  const re = new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, 'im');
  const match = notes.match(re);
  return match?.[1]?.trim() || null;
}

function upsertNoteLine(
  notes: string | null | undefined,
  label: string,
  value: string | null | undefined,
): string | null {
  const lines = (notes ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const re = new RegExp(`^${escapeRegExp(label)}:\\s*`, 'i');
  const without = lines.filter((line) => !re.test(line));
  const trimmed = value?.trim();
  if (trimmed) without.push(`${label}: ${trimmed}`);
  return without.length > 0 ? without.join('\n') : null;
}

function appendLogLine(
  notes: string | null | undefined,
  line: string,
): string | null {
  const existing = readNoteLine(notes, JOB_STATUS_LOG_KEY);
  const next = existing ? `${existing} | ${line}` : line;
  return upsertNoteLine(notes, JOB_STATUS_LOG_KEY, next);
}

export function readSaleJobStatus(
  notes: string | null | undefined,
): JobStage {
  const raw = readNoteLine(notes, JOB_STATUS_KEY);
  if (raw && isJobStage(raw)) return raw;
  return 'Received';
}

export function applySaleJobStatusNotes(args: {
  notes: string | null | undefined;
  status: string;
  staffNote?: string | null;
  hasQuote?: boolean;
}): { notes: string | null; status: JobStage } {
  const hasQuote = Boolean(args.hasQuote);
  const applicable = getApplicableStages(hasQuote);
  const requested = args.status.trim();
  if (!isJobStage(requested) || !applicable.includes(requested)) {
    throw new Error(
      `Invalid status “${requested}”. Allowed: ${applicable.join(', ')}`,
    );
  }
  const previous = readSaleJobStatus(args.notes);
  let nextNotes = upsertNoteLine(args.notes, JOB_STATUS_KEY, requested);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const staffNote = args.staffNote?.trim() ?? '';
  if (previous !== requested || staffNote) {
    const log =
      previous !== requested
        ? `[${stamp}] ${previous} → ${requested}${staffNote ? `: ${staffNote}` : ''}`
        : `[${stamp}] ${staffNote}`;
    nextNotes = appendLogLine(nextNotes, log);
  }
  return {
    notes: nextNotes,
    status: coerceJobStatus(requested, hasQuote),
  };
}

export { JOB_STATUS_KEY, JOB_STATUS_LOG_KEY };

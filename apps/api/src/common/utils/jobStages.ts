/**
 * Workshop stage pipeline. The implementation lives in `@vonos/types` so the
 * API and the Next.js app share one definition — this module stays as the
 * API-side import path (and the place for any server-only stage helpers).
 */
export {
  FIRST_STAGE,
  JOB_STAGES,
  QUOTED_STAGE,
  advanceLabelForStage,
  assertCanAdvance,
  assertCanReach,
  assertTransition,
  coerceJobStatus,
  getAdvanceLabel,
  getApplicableStages,
  getNextStage,
  isJobStage,
  isQcChecklistComplete,
  normalizeJobStage,
  toQcChecklist,
  type AdvanceGuardInput,
  type JobStage,
  type ReachGuardInput,
  type StageGateInput,
  type TransitionInput,
} from '@vonos/types';

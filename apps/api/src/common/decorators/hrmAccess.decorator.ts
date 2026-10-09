import { SetMetadata } from '@nestjs/common';

export const HRM_ACCESS_KEY = 'hrmAccess';

/**
 * What an `/hrm/*` handler requires from the caller.
 *
 * - `full` — the whole HRM module (HR / Accountant / Admin only).
 * - `any`  — any authenticated tenant user; the handler is responsible for
 *            narrowing the result itself (e.g. own payslips only).
 *
 * Defaults to `full` at controller level so a new HRM endpoint is private
 * unless it is explicitly marked `any`.
 */
export type HrmRouteRequirement = 'full' | 'any';

export const HrmAccess = (requirement: HrmRouteRequirement) =>
  SetMetadata(HRM_ACCESS_KEY, requirement);

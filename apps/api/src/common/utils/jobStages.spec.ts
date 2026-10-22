import {
  JOB_STAGES,
  advanceLabelForStage,
  assertCanAdvance,
  assertCanReach,
  coerceJobStatus,
  getAdvanceLabel,
  getApplicableStages,
  getNextStage,
  isJobStage,
  normalizeJobStage,
} from './jobStages';

describe('job stage pipeline', () => {
  it('exposes the eight workshop stages in order', () => {
    expect([...JOB_STAGES]).toEqual([
      'Received',
      'Diagnosis and billing',
      'Approved',
      'Initial deposit',
      'In progress',
      'Quality check',
      'Final payment',
      'Vehicle collected',
    ]);
  });

  it('drops only the diagnosis stage when the job has no quote', () => {
    expect(getApplicableStages(true)).toEqual([...JOB_STAGES]);
    expect(getApplicableStages(false)).not.toContain('Diagnosis and billing');
    expect(getApplicableStages(false)).toHaveLength(JOB_STAGES.length - 1);
  });

  it('rejects legacy labels as input but maps them on read', () => {
    expect(isJobStage('QC')).toBe(false);
    expect(isJobStage('Quality check')).toBe(true);
    expect(normalizeJobStage('QC')).toBe('Quality check');
    expect(normalizeJobStage('Delivered')).toBe('Vehicle collected');
    expect(normalizeJobStage('In Progress')).toBe('In progress');
    expect(normalizeJobStage('Quoted')).toBe('Diagnosis and billing');
    expect(normalizeJobStage('nonsense')).toBeNull();
  });

  it('coerces orphan statuses back onto the pipeline', () => {
    expect(coerceJobStatus('Delivered', true)).toBe('Vehicle collected');
    expect(coerceJobStatus('garbage', true)).toBe('Received');
    // Quote stage on a job whose quote was cleared.
    expect(coerceJobStatus('Diagnosis and billing', false)).toBe('Received');
    expect(coerceJobStatus('Quality check', false)).toBe('Quality check');
  });

  it('walks forward and stops at the final stage', () => {
    expect(getNextStage('Received', true)).toBe('Diagnosis and billing');
    expect(getNextStage('Approved', true)).toBe('Initial deposit');
    expect(getNextStage('Final payment', true)).toBe('Vehicle collected');
    expect(getNextStage('Vehicle collected', true)).toBeNull();
    expect(getNextStage('Received', false)).toBe('Approved');
  });

  it('labels the advance button from the stage being moved to', () => {
    expect(getAdvanceLabel('Received', true)).toBe('Begin diagnosis');
    expect(getAdvanceLabel('Approved', true)).toBe('Request deposit');
    expect(getAdvanceLabel('Initial deposit', true)).toBe('Start Work');
    expect(getAdvanceLabel('Final payment', true)).toBe(
      'Mark Vehicle collected',
    );
    expect(getAdvanceLabel('Vehicle collected', true)).toBeNull();
    expect(advanceLabelForStage(null)).toBe('Complete');
  });
});

describe('assertCanAdvance gates', () => {
  const base = { hasQuote: true, quoteAmount: 50_000 };

  it('requires a quote amount before approving a quoted job', () => {
    expect(() =>
      assertCanAdvance({
        ...base,
        currentStatus: 'Diagnosis and billing',
        quoteAmount: null,
      }),
    ).toThrow('Save a quote amount before marking Approved');

    expect(
      assertCanAdvance({ ...base, currentStatus: 'Diagnosis and billing' }),
    ).toBe('Approved');
  });

  it('requires the QC checklist before requesting final payment', () => {
    expect(() =>
      assertCanAdvance({
        ...base,
        currentStatus: 'Quality check',
        qcChecklist: { brakes: true, lights: false },
      }),
    ).toThrow('Complete the QC checklist before requesting final payment');

    expect(
      assertCanAdvance({
        ...base,
        currentStatus: 'Quality check',
        qcChecklist: { brakes: true, lights: true },
      }),
    ).toBe('Final payment');
  });

  it('blocks starting work until a deposit has been recorded', () => {
    const input = { ...base, currentStatus: 'Initial deposit' };

    expect(() =>
      assertCanAdvance({ ...input, expectedAmount: 80_000, paidAmount: 0 }),
    ).toThrow('Record the initial deposit before starting work');

    expect(
      assertCanAdvance({
        ...input,
        expectedAmount: 80_000,
        paidAmount: 20_000,
      }),
    ).toBe('In progress');
  });

  it('blocks handover until the balance is settled', () => {
    const input = { ...base, currentStatus: 'Final payment' };

    expect(() =>
      assertCanAdvance({
        ...input,
        expectedAmount: 80_000,
        paidAmount: 50_000,
      }),
    ).toThrow('₦30,000 due');

    expect(
      assertCanAdvance({
        ...input,
        expectedAmount: 80_000,
        paidAmount: 80_000,
      }),
    ).toBe('Vehicle collected');
    // Floating point / partial kobo tolerance.
    expect(
      assertCanAdvance({
        ...input,
        expectedAmount: 80_000,
        paidAmount: 79_999.9999999,
      }),
    ).toBe('Vehicle collected');
  });

  it('skips payment gates when nothing is known to be owed', () => {
    expect(
      assertCanAdvance({
        ...base,
        currentStatus: 'Initial deposit',
        expectedAmount: null,
        paidAmount: 0,
      }),
    ).toBe('In progress');

    expect(
      assertCanAdvance({
        ...base,
        currentStatus: 'Final payment',
        expectedAmount: null,
        paidAmount: 0,
      }),
    ).toBe('Vehicle collected');
  });

  it('refuses to advance past the final stage', () => {
    expect(() =>
      assertCanAdvance({ ...base, currentStatus: 'Vehicle collected' }),
    ).toThrow('Job is already at the final stage');
  });
});

describe('assertCanReach (explicit stage jumps)', () => {
  const base = { hasQuote: true, quoteAmount: 50_000 };

  it('rejects a stage that is not on the pipeline', () => {
    expect(() =>
      assertCanReach({
        ...base,
        currentStatus: 'Received',
        requestedStatus: 'QC',
      }),
    ).toThrow('Invalid status');
    expect(() =>
      assertCanReach({
        ...base,
        currentStatus: 'Received',
        requestedStatus: 'Diagnosis and billing',
      }),
    ).not.toThrow();
  });

  it('enforces every gate crossed by a forward jump', () => {
    expect(() =>
      assertCanReach({
        ...base,
        currentStatus: 'Approved',
        requestedStatus: 'In progress',
        expectedAmount: 100_000,
        paidAmount: 0,
      }),
    ).toThrow('Record the initial deposit before starting work');

    expect(() =>
      assertCanReach({
        ...base,
        currentStatus: 'Approved',
        requestedStatus: 'Vehicle collected',
        expectedAmount: 100_000,
        paidAmount: 0,
        qcChecklist: { brakes: false },
      }),
    ).toThrow();

    expect(
      assertCanReach({
        ...base,
        currentStatus: 'Approved',
        requestedStatus: 'Vehicle collected',
        expectedAmount: 100_000,
        paidAmount: 100_000,
        qcChecklist: { brakes: true },
      }),
    ).toBe('Vehicle collected');
  });

  it('allows moving backwards without re-checking gates', () => {
    expect(
      assertCanReach({
        ...base,
        currentStatus: 'Vehicle collected',
        requestedStatus: 'Received',
        expectedAmount: 100_000,
        paidAmount: 0,
      }),
    ).toBe('Received');
  });

  it('allows a no-op status set', () => {
    expect(
      assertCanReach({
        ...base,
        currentStatus: 'In progress',
        requestedStatus: 'In progress',
        expectedAmount: 100_000,
        paidAmount: 0,
      }),
    ).toBe('In progress');
  });
});

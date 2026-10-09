import { createHmac, timingSafeEqual } from 'crypto';

function shareSecret(): string {
  return (
    process.env.JOB_TRACK_SHARE_SECRET ||
    process.env.INVOICE_SHARE_SECRET ||
    process.env.JWT_SECRET ||
    'vonos-dev-job-track-share'
  );
}

/** Signed hex token for public job track URLs (`/job/:token`). */
export function encodePublicJobTrackToken(jobId: string): string {
  const sig = createHmac('sha256', shareSecret())
    .update(jobId)
    .digest('hex')
    .slice(0, 8);
  return Buffer.from(`${jobId}.${sig}`, 'utf8').toString('hex');
}

export function decodePublicJobTrackToken(token: string): string | null {
  if (!token || !/^[0-9a-f]+$/i.test(token)) return null;
  try {
    const raw = Buffer.from(token, 'hex').toString('utf8');
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const jobId = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!jobId || !sig) return null;
    const expected = createHmac('sha256', shareSecret())
      .update(jobId)
      .digest('hex')
      .slice(0, 8);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return jobId;
  } catch {
    return null;
  }
}

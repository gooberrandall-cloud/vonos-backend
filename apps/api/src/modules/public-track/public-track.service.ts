import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  coerceJobStatus,
  getApplicableStages,
  isJobStage,
  type JobStage,
} from '../../common/utils/jobStages';
import { compactPlateToken } from '../../common/utils/listSearch';
import { OPERATING_TENANTS } from '../../common/tenants/ensureOperatingTenant';
import { decodePublicJobTrackToken } from '../../common/utils/publicJobTrackToken';
import {
  JOB_STATUS_LOG_KEY,
  readSaleJobStatus,
} from '../../common/utils/saleJobStatusNotes';
import { toWhatsAppE164 } from '../../common/whatsapp/whatsapp-notify.service';

const TRACK_TENANT_CODES = ['VA', 'VP'] as const;

const STAGE_LABELS: Record<JobStage, string> = {
  Received: 'Checked in',
  Quoted: 'Quote ready',
  Approved: 'Work approved',
  'In Progress': 'Repair in progress',
  QC: 'Quality check',
  Delivered: 'Ready for collection',
};

const STAGE_DETAILS: Record<JobStage, string> = {
  Received: 'Your vehicle has been checked in and logged on the schedule.',
  Quoted: 'Inspection finished. A fixed-price quote is ready for approval.',
  Approved: 'Work has been authorised and is queued for the technicians.',
  'In Progress': 'Technicians are actively working on your vehicle.',
  QC: 'Repair complete — the team is running final quality checks.',
  Delivered: 'Your vehicle is ready for collection. Bring your ID and paperwork.',
};

export type PublicTrackStep = {
  id: string;
  label: string;
  detail: string;
  status: 'complete' | 'current' | 'upcoming';
  timestamp?: string;
};

export type PublicTrackResult = {
  name: string;
  registration: string;
  vehicle: string;
  service: string;
  /** Which shop currently has the car — never financials. */
  location: string;
  locationCode: 'VA' | 'VP';
  status: string;
  statusLabel: string;
  /**
   * Workshop lifecycle only — payment is separate.
   * `completed` = Delivered (work finished / ready or collected).
   */
  phase: 'active' | 'completed';
  /** Always null on public payloads (no staff names). */
  advisor: string | null;
  eta: string | null;
  reference: string;
  steps: PublicTrackStep[];
};

type JobTrackRow = {
  id: string;
  tenantId: string;
  reference: string;
  description: string | null;
  status: string;
  hasQuote: boolean;
  customerName: string | null;
  customerId: string | null;
  dueDate: Date | null;
  updatedAt: Date;
  vehicleId: string | null;
  /** Job qcNotes and/or sale “Job status log” for timeline timestamps. */
  statusHistory?: string | null;
};

type VehicleTrackRow = {
  id: string;
  plateNumber: string;
  make: string | null;
  model: string | null;
  year: number | null;
  ownerName: string | null;
};

@Injectable()
export class PublicTrackService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(args: {
    name: string;
    registration: string;
  }): Promise<PublicTrackResult> {
    const customerName = args.name.trim();
    const plate = compactPlateToken(args.registration);
    if (!customerName || plate.length < 3) {
      throw new NotFoundException('Enter your name and a valid registration plate.');
    }

    const tenantIds = this.trackTenantIds();

    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        OR: [
          { plateNumber: { equals: plate, mode: 'insensitive' } },
          {
            plateNumber: {
              equals: plate.replace(/-/g, ''),
              mode: 'insensitive',
            },
          },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        plateNumber: true,
        make: true,
        model: true,
        year: true,
        ownerName: true,
      },
    });

    const matchedVehicles = vehicles.filter(
      (v) => compactPlateToken(v.plateNumber) === plate,
    );

    if (matchedVehicles.length === 0) {
      throw new NotFoundException(
        'We could not match that registration plate. Check the plate spelling or ask the workshop to confirm it is on the job card.',
      );
    }

    const vehicleIds = matchedVehicles.map((v) => v.id);
    const jobSelect = {
      id: true,
      tenantId: true,
      reference: true,
      description: true,
      status: true,
      hasQuote: true,
      customerName: true,
      customerId: true,
      dueDate: true,
      updatedAt: true,
      vehicleId: true,
      qcNotes: true,
    } as const;

    let candidates = await this.prisma.job.findMany({
      where: {
        vehicleId: { in: vehicleIds },
        tenantId: { in: tenantIds },
        deletedAt: null,
        status: { not: 'Delivered' },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: jobSelect,
    });

    if (candidates.length === 0) {
      candidates = await this.prisma.job.findMany({
        where: {
          vehicleId: { in: vehicleIds },
          tenantId: { in: tenantIds },
          deletedAt: null,
          status: 'Delivered',
        },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: jobSelect,
      });
    }

    if (candidates.length === 0) {
      throw new NotFoundException(
        'No workshop job is linked to that plate yet. If you only paid a deposit or invoice, ask the workshop to open or update the job card.',
      );
    }

    const nameNorm = customerName.toLowerCase().replace(/\s+/g, ' ');
    const nameMatched = candidates.filter((job) => {
      const jobName = (job.customerName ?? '').toLowerCase().replace(/\s+/g, ' ');
      const vehicle = matchedVehicles.find((v) => v.id === job.vehicleId);
      const owner = (vehicle?.ownerName ?? '').toLowerCase().replace(/\s+/g, ' ');
      return (
        jobName.includes(nameNorm) ||
        nameNorm.includes(jobName.split(' ')[0] ?? '') ||
        owner.includes(nameNorm) ||
        nameNorm.includes(owner.split(' ')[0] ?? '')
      );
    });

    const job = nameMatched[0] ?? candidates[0]!;
    const vehicle = matchedVehicles.find((v) => v.id === job.vehicleId)!;
    return this.buildTrackResult(
      { ...job, statusHistory: job.qcNotes },
      vehicle,
      customerName,
    );
  }

  /** Public lookup via signed `/job/:token` share link (Job or Sale id). */
  async lookupByToken(token: string): Promise<PublicTrackResult> {
    const subjectId = decodePublicJobTrackToken(token);
    if (!subjectId) {
      throw new NotFoundException('This track link is invalid or expired.');
    }

    const tenantIds = this.trackTenantIds();
    const job = await this.prisma.job.findFirst({
      where: {
        id: subjectId,
        tenantId: { in: tenantIds },
        deletedAt: null,
      },
      select: {
        id: true,
        tenantId: true,
        reference: true,
        description: true,
        status: true,
        hasQuote: true,
        customerName: true,
        customerId: true,
        dueDate: true,
        updatedAt: true,
        vehicleId: true,
        qcNotes: true,
      },
    });
    if (job) {
      let vehicle: VehicleTrackRow | null = null;
      if (job.vehicleId) {
        vehicle = await this.prisma.vehicle.findFirst({
          where: { id: job.vehicleId, deletedAt: null },
          select: {
            id: true,
            plateNumber: true,
            make: true,
            model: true,
            year: true,
            ownerName: true,
          },
        });
      }

      return this.buildTrackResult(
        { ...job, statusHistory: job.qcNotes },
        vehicle ?? {
          id: '',
          plateNumber: '—',
          make: null,
          model: null,
          year: null,
          ownerName: null,
        },
        job.customerName ?? 'Customer',
      );
    }

    // VA/VP: sales act as jobs — token may encode the sale id directly.
    const sale = await this.prisma.sale.findFirst({
      where: {
        id: subjectId,
        tenantId: { in: tenantIds },
        deletedAt: null,
      },
      select: {
        id: true,
        tenantId: true,
        reference: true,
        notes: true,
        updatedAt: true,
        customer: { select: { name: true } },
        job: {
          select: {
            hasQuote: true,
            vehicleId: true,
            description: true,
            customerName: true,
            dueDate: true,
            qcNotes: true,
          },
        },
        lines: {
          take: 3,
          select: { name: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!sale) {
      throw new NotFoundException('We could not find a workshop job for this link.');
    }

    return this.buildTrackResultFromSale(sale);
  }

  /**
   * After a successful plate+name match, save the WhatsApp number the customer
   * entered onto the vehicle — that number is what status notifies use.
   */
  async subscribeWhatsApp(args: {
    name: string;
    registration: string;
    whatsapp: string;
  }): Promise<{ ok: true; phone: string }> {
    const e164 = toWhatsAppE164(args.whatsapp);
    if (!e164) {
      throw new BadRequestException(
        'Enter a valid WhatsApp number (e.g. 0803 123 4567).',
      );
    }

    const match = await this.resolveActiveJobMatch({
      name: args.name,
      registration: args.registration,
    });

    const displayPhone = `+${e164}`;
    await this.prisma.vehicle.update({
      where: { id: match.vehicleId },
      data: {
        ownerPhone: displayPhone,
        ...(args.name.trim()
          ? { ownerName: args.name.trim() }
          : {}),
      },
    });

    if (match.customerId) {
      await this.prisma.customer.updateMany({
        where: { id: match.customerId, deletedAt: null },
        data: { phone: displayPhone },
      });
    }

    return { ok: true, phone: displayPhone };
  }

  private trackTenantIds(): string[] {
    return OPERATING_TENANTS.filter((t) =>
      (TRACK_TENANT_CODES as readonly string[]).includes(t.code),
    ).map((t) => t.id);
  }

  private buildTrackResult(
    job: JobTrackRow,
    vehicle: VehicleTrackRow,
    fallbackName: string,
  ): PublicTrackResult {
    const stage = coerceJobStatus(job.status, job.hasQuote);
    const completed = stage === 'Delivered';
    const stages = getApplicableStages(job.hasQuote);
    const currentIndex = stages.indexOf(stage);
    const enteredAt = parseStageEnteredAt(job.statusHistory);

    const steps: PublicTrackStep[] = stages.map((s, index) => {
      let status: PublicTrackStep['status'] = 'upcoming';
      if (completed || index < currentIndex) status = 'complete';
      else if (index === currentIndex) status = 'current';

      const fromLog = enteredAt.get(s);
      let timestamp: string | undefined;
      if (fromLog) {
        timestamp = formatTrackDate(fromLog);
      } else if (
        status === 'current' ||
        (completed && s === 'Delivered')
      ) {
        timestamp = formatTrackDate(job.updatedAt);
      }

      return {
        id: s.toLowerCase().replace(/\s+/g, '-'),
        label: STAGE_LABELS[s],
        detail:
          completed && s === 'Delivered'
            ? 'Your repair is marked complete. Collect your vehicle if you have not already, or contact the team with any follow-up.'
            : STAGE_DETAILS[s],
        status,
        timestamp,
      };
    });

    const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      name: job.customerName?.trim() || vehicle.ownerName || fallbackName,
      registration: compactPlateToken(vehicle.plateNumber) || vehicle.plateNumber,
      vehicle: vehicleLabel || 'Vehicle',
      // Never expose parts lists or which VA/VP entity has the car.
      service: '',
      location: '',
      locationCode: 'VA',
      status: stage,
      statusLabel: completed ? 'Repair completed' : STAGE_LABELS[stage],
      phase: completed ? 'completed' : 'active',
      advisor: null,
      eta: completed
        ? null
        : job.dueDate
          ? formatTrackDate(job.dueDate)
          : null,
      reference: job.reference,
      steps,
    };
  }

  private async buildTrackResultFromSale(sale: {
    id: string;
    tenantId: string;
    reference: string;
    notes: string | null;
    updatedAt: Date;
    customer: { name: string } | null;
    job: {
      hasQuote: boolean;
      vehicleId: string | null;
      description: string | null;
      customerName: string | null;
      dueDate: Date | null;
      qcNotes: string | null;
    } | null;
    lines: Array<{ name: string }>;
  }): Promise<PublicTrackResult> {
    let vehicle: VehicleTrackRow | null = null;
    if (sale.job?.vehicleId) {
      vehicle = await this.prisma.vehicle.findFirst({
        where: { id: sale.job.vehicleId, deletedAt: null },
        select: {
          id: true,
          plateNumber: true,
          make: true,
          model: true,
          year: true,
          ownerName: true,
        },
      });
    }

    const plateFromNotes = readPublicSaleNoteLine(sale.notes, 'Plate number');
    const modelFromNotes = readPublicSaleNoteLine(sale.notes, 'Car model & year');
    const hasQuote = sale.job?.hasQuote ?? false;
    const stage = coerceJobStatus(readSaleJobStatus(sale.notes), hasQuote);
    const saleLog = readPublicSaleNoteLine(sale.notes, JOB_STATUS_LOG_KEY);
    const statusHistory =
      [saleLog, sale.job?.qcNotes].filter(Boolean).join('\n') || null;

    const syntheticJob: JobTrackRow = {
      id: sale.id,
      tenantId: sale.tenantId,
      reference: sale.reference,
      description: null,
      status: stage,
      hasQuote,
      customerName:
        sale.customer?.name?.trim() ||
        sale.job?.customerName?.trim() ||
        null,
      customerId: null,
      dueDate: sale.job?.dueDate ?? null,
      updatedAt: sale.updatedAt,
      vehicleId: sale.job?.vehicleId ?? null,
      statusHistory,
    };

    const vehicleRow: VehicleTrackRow = vehicle ?? {
      id: '',
      plateNumber: plateFromNotes || '—',
      make: null,
      model: modelFromNotes,
      year: null,
      ownerName: sale.customer?.name ?? null,
    };

    return this.buildTrackResult(
      syntheticJob,
      vehicleRow,
      sale.customer?.name ?? 'Customer',
    );
  }

  private async resolveActiveJobMatch(args: {
    name: string;
    registration: string;
  }): Promise<{ vehicleId: string; customerId: string | null }> {
    const customerName = args.name.trim();
    const plate = compactPlateToken(args.registration);
    if (!customerName || plate.length < 3) {
      throw new NotFoundException(
        'Enter your name and a valid registration plate.',
      );
    }

    const tenantIds = this.trackTenantIds();

    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        tenantId: { in: tenantIds },
        deletedAt: null,
        OR: [
          { plateNumber: { equals: plate, mode: 'insensitive' } },
          {
            plateNumber: {
              equals: plate.replace(/-/g, ''),
              mode: 'insensitive',
            },
          },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        plateNumber: true,
        ownerName: true,
      },
    });

    const matchedVehicles = vehicles.filter(
      (v) => compactPlateToken(v.plateNumber) === plate,
    );
    if (matchedVehicles.length === 0) {
      throw new NotFoundException(
        'We could not match that registration plate.',
      );
    }

    const vehicleIds = matchedVehicles.map((v) => v.id);
    let candidates = await this.prisma.job.findMany({
      where: {
        vehicleId: { in: vehicleIds },
        tenantId: { in: tenantIds },
        deletedAt: null,
        status: { not: 'Delivered' },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        vehicleId: true,
        customerId: true,
        customerName: true,
      },
    });
    if (candidates.length === 0) {
      candidates = await this.prisma.job.findMany({
        where: {
          vehicleId: { in: vehicleIds },
          tenantId: { in: tenantIds },
          deletedAt: null,
          status: 'Delivered',
        },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          vehicleId: true,
          customerId: true,
          customerName: true,
        },
      });
    }
    if (candidates.length === 0) {
      throw new NotFoundException(
        'No workshop job is linked to that plate yet.',
      );
    }

    const nameNorm = customerName.toLowerCase().replace(/\s+/g, ' ');
    const nameMatched = candidates.filter((job) => {
      const jobName = (job.customerName ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const vehicle = matchedVehicles.find((v) => v.id === job.vehicleId);
      const owner = (vehicle?.ownerName ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return (
        jobName.includes(nameNorm) ||
        nameNorm.includes(jobName.split(' ')[0] ?? '') ||
        owner.includes(nameNorm) ||
        nameNorm.includes(owner.split(' ')[0] ?? '')
      );
    });

    const job = nameMatched[0] ?? candidates[0]!;
    return {
      vehicleId: job.vehicleId!,
      customerId: job.customerId,
    };
  }
}

function formatTrackDate(value: Date): string {
  return value.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Map first time each workshop stage was entered from sale/job status logs.
 * Supports:
 * - `[2026-09-20 14:30] Received → Approved: note`
 * - `[2026-09-20 14:30] Status → Approved: note`
 * Pipe- or newline-separated segments.
 */
function parseStageEnteredAt(
  history: string | null | undefined,
): Map<JobStage, Date> {
  const map = new Map<JobStage, Date>();
  if (!history?.trim()) return map;

  const cleaned = history.replace(/^Job status log:\s*/im, '');
  const segments = cleaned
    .split(/\s*\|\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const stampRe =
    /\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\]\s*(.+)$/i;

  for (const segment of segments) {
    const match = segment.match(stampRe);
    if (!match) continue;
    const stampRaw = match[1]!.replace(' ', 'T');
    const rest = match[2]!.trim();
    const at = new Date(stampRaw.length === 16 ? `${stampRaw}:00` : stampRaw);
    if (Number.isNaN(at.getTime())) continue;

    let entered: string | null = null;
    const statusArrow = rest.match(/^Status\s*→\s*([^:]+)/i);
    if (statusArrow) {
      entered = statusArrow[1]!.trim();
    } else {
      const transition = rest.match(/^(.+?)\s*→\s*([^:]+)/);
      if (transition) {
        entered = transition[2]!.trim();
      }
    }

    if (!entered || !isJobStage(entered)) continue;
    if (!map.has(entered)) {
      map.set(entered, at);
    }
  }

  return map;
}

function readPublicSaleNoteLine(
  notes: string | null | undefined,
  label: string,
): string | null {
  if (!notes?.trim()) return null;
  const re = new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`,
    'im',
  );
  const match = notes.match(re);
  return match?.[1]?.trim() || null;
}

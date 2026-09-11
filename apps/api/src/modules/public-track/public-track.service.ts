import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  coerceJobStatus,
  getApplicableStages,
  type JobStage,
} from '../../common/utils/jobStages';
import { compactPlateToken } from '../../common/utils/listSearch';
import { OPERATING_TENANTS } from '../../common/tenants/ensureOperatingTenant';
import { toWhatsAppE164 } from '../../common/whatsapp/whatsapp-notify.service';

const TRACK_TENANT_CODES = ['VA', 'VP'] as const;

const STAGE_LABELS: Record<JobStage, string> = {
  Received: 'Received at workshop',
  Quoted: 'Quote ready',
  Approved: 'Work approved',
  'In Progress': 'Repair in progress',
  QC: 'Quality check',
  Delivered: 'Ready for collection',
};

const STAGE_DETAILS: Record<JobStage, string> = {
  Received: 'Your vehicle has been checked in and logged on the workshop schedule.',
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
  advisor: string | null;
  eta: string | null;
  reference: string;
  steps: PublicTrackStep[];
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

    const tenantIds = OPERATING_TENANTS.filter((t) =>
      (TRACK_TENANT_CODES as readonly string[]).includes(t.code),
    ).map((t) => t.id);

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

    // Also match plates stored with hyphens / spaces variants via normalized compare.
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
      createdByName: true,
      dueDate: true,
      updatedAt: true,
      vehicleId: true,
    } as const;

    // Prefer in-progress work; if none, show the latest completed (Delivered) job.
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
    const tenantMeta = OPERATING_TENANTS.find((t) => t.id === job.tenantId);
    const locationCode = (tenantMeta?.code === 'VP' ? 'VP' : 'VA') as 'VA' | 'VP';
    const location =
      tenantMeta?.name ??
      (locationCode === 'VP' ? 'Vonos Painting' : 'Vonos Mechanic');

    const stage = coerceJobStatus(job.status, job.hasQuote);
    const completed = stage === 'Delivered';
    const stages = getApplicableStages(job.hasQuote);
    const currentIndex = stages.indexOf(stage);

    const steps: PublicTrackStep[] = stages.map((s, index) => {
      let status: PublicTrackStep['status'] = 'upcoming';
      if (completed || index < currentIndex) status = 'complete';
      else if (index === currentIndex) status = 'current';
      return {
        id: s.toLowerCase().replace(/\s+/g, '-'),
        label: STAGE_LABELS[s],
        detail:
          completed && s === 'Delivered'
            ? 'This repair is marked complete. Collect your vehicle if you have not already, or contact the workshop with any follow-up.'
            : STAGE_DETAILS[s],
        status,
        timestamp:
          completed && s === 'Delivered'
            ? formatTrackDate(job.updatedAt)
            : index === currentIndex
              ? formatTrackDate(job.updatedAt)
              : undefined,
      };
    });

    const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      name: job.customerName?.trim() || vehicle.ownerName || customerName,
      registration: compactPlateToken(vehicle.plateNumber),
      vehicle: vehicleLabel || 'Vehicle',
      service: job.description?.trim() || 'Workshop service',
      location,
      locationCode,
      status: stage,
      statusLabel: completed
        ? 'Repair completed'
        : STAGE_LABELS[stage],
      phase: completed ? 'completed' : 'active',
      advisor: job.createdByName?.trim() || null,
      eta: completed
        ? null
        : job.dueDate
          ? formatTrackDate(job.dueDate)
          : null,
      reference: job.reference,
      steps,
    };
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

    // Keep customer phone in sync when the job has a customer.
    if (match.customerId) {
      await this.prisma.customer.updateMany({
        where: { id: match.customerId, deletedAt: null },
        data: { phone: displayPhone },
      });
    }

    return { ok: true, phone: displayPhone };
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

    const tenantIds = OPERATING_TENANTS.filter((t) =>
      (TRACK_TENANT_CODES as readonly string[]).includes(t.code),
    ).map((t) => t.id);

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

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import type { BusinessLocation } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decodePublicInvoiceToken } from '../../common/utils/publicInvoiceToken';
import {
  mapSaleStatusToUi,
  toIso,
  toNumber,
} from '../../common/utils/serializers';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Legal letterhead on public invoices — group name, not per-tenant labels. */
const INVOICE_BUSINESS_NAME = 'VONOS GROUP LTD';
const INVOICE_ADDRESS = 'Vonos plaza, vonos roundabout, fo1, kubwa';
const INVOICE_MOBILE_PRIMARY = '09128690691';
const INVOICE_MOBILE_SECONDARY = '07075179952';
const INVOICE_EMAIL = 'operations@vonosgroupltd.com';

function invoiceSectionLabel(tenantCode?: string | null): string | null {
  const code = (tenantCode ?? '').trim().toUpperCase();
  if (code === 'VA') return 'Section — Mechanic';
  if (code === 'VP') return 'Section — Painting';
  if (code === 'VW') return 'Section — Warehouse';
  if (code === 'VISP' || code === 'VSP') return 'Section — Spare Parts';
  if (code === 'VC') return 'Section — Cafe';
  if (code === 'VS') return 'Section — Saloon';
  if (code === 'VKW') return 'Section — Kids Wear';
  return null;
}

function resolveLocation(
  config: Record<string, unknown>,
  locationCode: string | null,
): BusinessLocation | null {
  const raw = config.businessLocations;
  if (!Array.isArray(raw) || !locationCode) return null;
  const code = locationCode.trim().toLowerCase();
  for (const row of raw) {
    const loc = asRecord(row);
    const rowCode = str(loc.code);
    if (rowCode && rowCode.toLowerCase() === code) {
      return {
        code: rowCode,
        name: str(loc.name) || rowCode,
        landmark: str(loc.landmark) ?? undefined,
        city: str(loc.city) ?? undefined,
        zipCode: str(loc.zipCode) ?? undefined,
        state: str(loc.state) ?? undefined,
        country: str(loc.country) ?? undefined,
        mobile: str(loc.mobile) ?? undefined,
        alternateNumber: str(loc.alternateNumber) ?? undefined,
        email: str(loc.email) ?? undefined,
      };
    }
  }
  return null;
}

function formatLocationAddress(loc: BusinessLocation | null): string | null {
  if (!loc) return null;
  const parts = [loc.landmark, loc.city, loc.state, loc.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Unauthenticated HQ6-style invoice view (`/invoice/:token`). */
@Controller('public/invoices')
export class PublicInvoicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':token')
  async getByToken(@Param('token') token: string) {
    const saleId = decodePublicInvoiceToken(token);
    if (!saleId) throw new NotFoundException('Invoice not found');

    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, deletedAt: null },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
            email: true,
          },
        },
        serviceStaffEmployee: { select: { name: true } },
        job: {
          select: {
            reference: true,
            vehicleId: true,
          },
        },
        tenant: { select: { name: true, code: true, config: true } },
        lines: { orderBy: { createdAt: 'asc' } },
        payments: {
          where: { deletedAt: null, isReturn: false },
          orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
          include: { account: { select: { name: true } } },
        },
      },
    });
    if (!sale) throw new NotFoundException('Invoice not found');

    const config = asRecord(sale.tenant.config);
    const location = resolveLocation(config, sale.locationCode);
    const locationAddress = formatLocationAddress(location);
    const locationLabel = location?.name ?? sale.locationCode;

    let vehicleLabel: string | null = null;
    if (sale.job?.vehicleId) {
      const vehicle = await this.prisma.vehicle.findFirst({
        where: {
          id: sale.job.vehicleId,
          tenantId: sale.tenantId,
          deletedAt: null,
        },
        select: { make: true, model: true, plateNumber: true },
      });
      if (vehicle) {
        vehicleLabel =
          `${vehicle.make}-${vehicle.model} ${vehicle.plateNumber}`.trim() ||
          null;
      }
    }

    const totalPaid = sale.payments.reduce(
      (sum, row) => sum + toNumber(row.amount),
      0,
    );

    return {
      token,
      businessName: INVOICE_BUSINESS_NAME,
      businessSection: invoiceSectionLabel(sale.tenant.code),
      businessLocation: locationLabel,
      businessLocationAddress: locationAddress,
      businessAddress: INVOICE_ADDRESS,
      businessMobile: INVOICE_MOBILE_PRIMARY,
      businessMobileSecondary: INVOICE_MOBILE_SECONDARY,
      businessEmail: INVOICE_EMAIL,
      sale: {
        id: sale.id,
        tenantId: sale.tenantId,
        reference: sale.reference,
        customerId: sale.customerId,
        customerName: sale.customer?.name || 'Walk-in Customer',
        customerPhone: sale.customer?.phone ?? null,
        customerEmail: sale.customer?.email ?? null,
        vehicleLabel,
        jobId: sale.jobId,
        jobReference: sale.job?.reference ?? null,
        total: toNumber(sale.total),
        currency: sale.currency,
        status: mapSaleStatusToUi(sale.status),
        recordStatus: sale.status,
        paymentStatus: sale.paymentStatus,
        paymentMethod: sale.paymentMethod,
        locationCode: sale.locationCode,
        cleanerName: sale.cleanerName ?? null,
        serviceStaffEmployeeId: sale.serviceStaffEmployeeId,
        serviceStaffEmployeeName:
          sale.serviceStaffEmployee?.name ?? sale.cleanerName ?? null,
        createdByName: sale.createdByName,
        shippingStatus: sale.shippingStatus,
        shippingAddress: sale.shippingAddress,
        trackingNumber: sale.trackingNumber,
        itemCount: sale.lines.length,
        date: toIso(sale.date),
        discountAmount: sale.discountAmount
          ? toNumber(sale.discountAmount)
          : null,
        taxAmount: sale.taxAmount ? toNumber(sale.taxAmount) : null,
        notes: sale.notes,
        totalPaid,
        createdAt: toIso(sale.createdAt),
        updatedAt: toIso(sale.updatedAt),
        lines: sale.lines.map((line) => ({
          id: line.id,
          saleId: line.saleId,
          itemId: line.itemId,
          sku: line.sku,
          name: line.name,
          quantity: toNumber(line.quantity),
          unitPrice: toNumber(line.unitPrice),
          lineTotal: toNumber(line.lineTotal),
          discountAmount: line.discountAmount
            ? toNumber(line.discountAmount)
            : null,
        })),
      },
      payments: sale.payments.map((row) => ({
        id: row.id,
        amount: toNumber(row.amount),
        currency: row.currency,
        method: row.method,
        paymentRefNo: row.paymentRefNo,
        paidOn: row.paidOn ? toIso(row.paidOn) : null,
        note: row.note,
        accountId: row.accountId,
        accountName: row.account?.name ?? null,
        createdByName: null,
      })),
      // Legacy flat fields (kept for older clients)
      reference: sale.reference,
      date: toIso(sale.date),
      paymentStatus: sale.paymentStatus,
      currency: sale.currency,
      total: toNumber(sale.total),
      customerName: sale.customer?.name || 'Walk-in Customer',
      customerPhone: sale.customer?.phone ?? null,
      customerEmail: sale.customer?.email ?? null,
      lines: sale.lines.map((line) => ({
        sku: line.sku,
        name: line.name,
        quantity: toNumber(line.quantity),
        unitPrice: toNumber(line.unitPrice),
        lineTotal: toNumber(line.lineTotal),
      })),
    };
  }
}

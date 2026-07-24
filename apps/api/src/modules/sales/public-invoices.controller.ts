import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decodePublicInvoiceToken } from '../../common/utils/publicInvoiceToken';
import { toIso, toNumber } from '../../common/utils/serializers';

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

    const config =
      sale.tenant.config &&
      typeof sale.tenant.config === 'object' &&
      !Array.isArray(sale.tenant.config)
        ? (sale.tenant.config as Record<string, unknown>)
        : {};
    const businessSettings =
      config.businessSettings &&
      typeof config.businessSettings === 'object' &&
      !Array.isArray(config.businessSettings)
        ? (config.businessSettings as Record<string, unknown>)
        : {};
    const businessBag =
      businessSettings.business &&
      typeof businessSettings.business === 'object' &&
      !Array.isArray(businessSettings.business)
        ? (businessSettings.business as Record<string, unknown>)
        : {};

    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() ? value.trim() : null;

    return {
      token,
      reference: sale.reference,
      date: toIso(sale.date),
      paymentStatus: sale.paymentStatus,
      currency: sale.currency,
      total: toNumber(sale.total),
      customerName: sale.customer?.name || 'Walk-in Customer',
      customerPhone: sale.customer?.phone ?? null,
      customerEmail: sale.customer?.email ?? null,
      businessName: sale.tenant.name,
      businessLocation: sale.locationCode,
      businessMobile:
        str(businessBag.mobile) ||
        str(businessBag.phone) ||
        null,
      businessEmail: str(businessBag.email) || null,
      lines: sale.lines.map((line) => ({
        sku: line.sku,
        name: line.name,
        quantity: toNumber(line.quantity),
        unitPrice: toNumber(line.unitPrice),
        lineTotal: toNumber(line.lineTotal),
      })),
      payments: sale.payments.map((row) => ({
        id: row.id,
        amount: toNumber(row.amount),
        currency: row.currency,
        method: row.method,
        paymentRefNo: row.paymentRefNo,
        paidOn: row.paidOn ? toIso(row.paidOn) : null,
        note: row.note,
        accountName: row.account?.name ?? null,
      })),
    };
  }
}

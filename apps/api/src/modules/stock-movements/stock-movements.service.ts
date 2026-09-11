import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import type {
  MovementSource,
  MovementStatus,
  MovementType,
  PayContactDueRequest,
  PurchasePaymentStatus,
  PurchaseViewBundle,
} from '@vonos/types';
import { shouldAdjustLocalItemStock } from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import { CacheService } from '../../common/cache/cache.service';
import {
  invalidateTenantDashboardCache,
  invalidateTenantListCache,
} from '../../common/cache/cacheInvalidation';
import { applyDailyFinanceDelta } from '../../common/utils/dailyFinanceRollup';
import { refreshSupplierPurchaseRollups } from '../../common/utils/supplierRollups';
import {
  listPageFilterKey,
  withListPageCache,
} from '../../common/utils/listPageCache';
import {
  HQ6_LIST_WARM_LIMITS,
  hq6WarmSorts,
} from '../../common/utils/hq6ListWarm';
import { buildCompositeCursorQuery } from '../../common/utils/pagination';
import type { PaginatedList } from '../../common/utils/paginatedList';
import { resolveListSort } from '../../common/utils/listSort';
import {
  computeStockStatus,
  movementLineRollups,
  movementLineQtyByItemId,
  parseMovementLines,
  inboundReceiptStockDelta,
  shouldApplyInboundQty,
  shouldApplyOutboundQty,
} from '../../common/utils/stockQuantity';
import {
  applyInboundStockDeltas,
  inboundStockLineLookup,
} from '../../common/utils/applyInboundStockDeltas';
import {
  purchaseHeaderChanged,
  purchaseLinesEqual,
} from '../../common/utils/purchaseDiff';
import { resolveActiveItem } from '../../common/utils/resolveActiveItem';
import { toIso, toNumber } from '../../common/utils/serializers';
import { paymentStatusFromAmounts } from '../../common/utils/paymentStatus';
import { adjustItemLocationStock } from '../../common/utils/itemLocationStock';
import {
  recordPaymentAccountTxn,
  softDeletePaymentAccountTxns,
  syncPurchasePaymentAccountDebit,
} from '../../common/utils/recordPaymentAccountTxn';
import {
  stockMovementTextSearchWhere,
  transferTextSearchWhere,
} from '../../common/utils/listSearch';
import { excludeOpeningStockPurchasesWhere } from '../../common/utils/openingStockMovement';
import {
  serializeMovement,
  toMovementListRow,
  toTransferRow,
  type StockMovementListRow,
  type TransferRow,
  type TransferZoneSummary,
} from './stock-movements.mapper';
import { AuditService } from '../audit/audit.service';
import { InvoiceHubService } from '../invoices/invoice-hub.service';

/** Neon pooler + multi-line stock side-effects need more than the 5s default. */
const PURCHASE_TX_OPTIONS = {
  maxWait: 15_000,
  timeout: 60_000,
} as const;

function movementStatusWhere(
  status?: MovementStatus,
): { status: MovementStatus } | { status: { in: MovementStatus[] } } | Record<string, never> {
  if (!status) return {};
  // Purchase UI maps "Delivered" to Received or Delivered in DB
  if (status === 'Delivered') {
    return { status: { in: ['Received', 'Delivered'] } };
  }
  // Ordered / Pending and other statuses: exact match
  return { status };
}

/** Map transfer list UI status (or tab id) to DB MovementStatus values. */
function transferDbStatuses(
  status?: string,
): MovementStatus[] | undefined {
  if (!status || status === 'all') return undefined;
  switch (status) {
    case 'Pending':
    case 'pending':
      return ['Pending'];
    case 'In Transit':
    case 'in_transit':
      return ['Approved', 'Shipped'];
    case 'Completed':
    case 'completed':
      return ['Received', 'Delivered'];
    case 'Rejected':
    case 'rejected':
      // No dedicated Rejected status in MovementStatus — treat Ordered as cancelled/rejected transfers.
      return ['Ordered'];
    default:
      return undefined;
  }
}

@Injectable()
export class StockMovementsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
    private readonly invoiceHub: InvoiceHubService,
  ) {}

  /** VA / VP / job catalog — purchases must not adjust Item.quantity. */
  private async tenantStockContext(tenantId: string): Promise<{
    code: string | null;
    archetype: string | null;
  }> {
    // Prefer request-memoized tenant load (shared with location resolve).
    if (tenantId === this.tenantDb.resolveTenantId()) {
      const tenant = await this.tenantDb.getTenantCodeAndConfig();
      const cfg = tenant?.config as { archetype?: string | null } | null;
      return {
        code: tenant?.code ?? null,
        archetype: cfg?.archetype ?? null,
      };
    }
    const row = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { code: true, config: true },
    });
    const cfg = row?.config as { archetype?: string | null } | null;
    return {
      code: row?.code ?? null,
      archetype: cfg?.archetype ?? null,
    };
  }

  private async skipsLocalStock(tenantId: string): Promise<boolean> {
    const tenant = await this.tenantStockContext(tenantId);
    return !shouldAdjustLocalItemStock(tenant, null);
  }

  async list(filters: {
    type?: MovementType;
    status?: MovementStatus;
    source?: MovementSource;
    locationCode?: string;
    supplierId?: string;
    paymentStatus?: PurchasePaymentStatus;
    paymentMethod?: string;
    search?: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
    sortBy?: string;
    sortDir?: string;
    /** When false, skip count for rows-first paint. */
    includeSummary?: boolean;
  }): Promise<PaginatedList<StockMovementListRow>> {
    const tenantId = this.tenantDb.requireTenantId();
    // Sort by computed totals isn't a DB column — fall back to date.
    const sortBy =
      filters.sortBy === 'paymentDue'
        ? 'grandTotal'
        : filters.sortBy === 'supplierOrDest'
          ? 'supplierId'
          : filters.sortBy;
    const filterKey = listPageFilterKey({
      type: filters.type,
      status: filters.status,
      source: filters.source,
      locationCode: filters.locationCode,
      supplierId: filters.supplierId,
      paymentStatus: filters.paymentStatus,
      paymentMethod: filters.paymentMethod,
      search: filters.search,
      from: filters.from,
      to: filters.to,
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortBy,
      sortDir: filters.sortDir,
      sum: filters.includeSummary === true ? 1 : 0,
    });

    return withListPageCache(
      this.cache,
      tenantId,
      'stock-movements:v3',
      filterKey,
      async () => {
        const dateFilter =
          filters.from || filters.to
            ? {
                date: {
                  ...(filters.from ? { gte: new Date(filters.from) } : {}),
                  ...(filters.to ? { lte: new Date(filters.to) } : {}),
                },
              }
            : {};
        const sort = resolveListSort(
          sortBy,
          filters.sortDir,
          {
            date: { field: 'date', type: 'date' },
            reference: { field: 'reference', type: 'string' },
            status: { field: 'status', type: 'string' },
            createdAt: { field: 'createdAt', type: 'date' },
            updatedAt: { field: 'updatedAt', type: 'date' },
            locationCode: { field: 'locationCode', type: 'string' },
            paymentStatus: { field: 'paymentStatus', type: 'string' },
            paymentMethod: { field: 'paymentMethod', type: 'string' },
            grandTotal: { field: 'grandTotal', type: 'number' },
            supplierId: { field: 'supplierId', type: 'string' },
          },
          {
            sortField: 'updatedAt',
            sortDir: 'desc',
            sortValueType: 'date',
          },
        );
        const pagination = buildCompositeCursorQuery({
          sortField: sort.sortField,
          sortDir: sort.sortDir,
          cursor: filters.cursor,
          limit: filters.limit ?? 10,
          sortValueType: sort.sortValueType,
        });
        const baseWhere = {
          tenantId,
          deletedAt: null as null,
          ...(filters.type ? { type: filters.type } : {}),
          ...excludeOpeningStockPurchasesWhere(),
          ...movementStatusWhere(filters.status),
          ...(filters.source ? { source: filters.source } : {}),
          ...(filters.locationCode
            ? { locationCode: filters.locationCode }
            : {}),
          ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
          ...(filters.paymentStatus
            ? filters.paymentStatus === 'due'
              ? // Migrated purchases often have null paymentStatus; treat as due.
                {
                  OR: [
                    { paymentStatus: 'due' as const },
                    { paymentStatus: null },
                  ],
                }
              : { paymentStatus: filters.paymentStatus }
            : {}),
          ...(filters.paymentMethod
            ? { paymentMethod: filters.paymentMethod }
            : {}),
          ...(stockMovementTextSearchWhere(filters.search) ?? {}),
          ...dateFilter,
        };
        // Skip lines JSON on list — use denormalized itemCount / grandTotal.
        const includeSummary = filters.includeSummary === true;
        // Summary fetch uses limit=1 and only reads totalCount — skip page work.
        const countOnly =
          includeSummary && !filters.cursor && (filters.limit ?? 10) === 1;

        if (countOnly) {
          const totalCount = await this.tenantDb.db.stockMovement.count({
            where: baseWhere,
          });
          return { items: [], totalCount };
        }

        const [rows, totalCount] = await Promise.all([
          this.tenantDb.db.stockMovement.findMany({
            where: {
              ...baseWhere,
              ...(pagination.where ?? {}),
            },
            select: {
              id: true,
              tenantId: true,
              type: true,
              reference: true,
              status: true,
              notes: true,
              locationCode: true,
              supplierId: true,
              source: true,
              paymentStatus: true,
              paymentMethod: true,
              totalPaid: true,
              date: true,
              itemCount: true,
              grandTotal: true,
              createdByUserId: true,
              createdByName: true,
              createdAt: true,
              updatedAt: true,
              deletedAt: true,
              supplier: { select: { name: true } },
            },
            orderBy: [{ [sort.sortField]: sort.sortDir }, { id: sort.sortDir }],
            take: pagination.take,
          }),
          includeSummary
            ? this.tenantDb.db.stockMovement.count({ where: baseWhere })
            : Promise.resolve(undefined as number | undefined),
        ]);

        return {
          items: rows.map((row) =>
            toMovementListRow({
              ...row,
              lines: [],
            }),
          ),
          ...(totalCount != null ? { totalCount } : {}),
        };
      },
    );
  }

  async getById(id: string) {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Movement not found');
    return serializeMovement(row);
  }

  /**
   * Purchase payments are stored as:
   * - App: paymentFor='purchase' + paymentRefNo=PO reference
   * - Migrated: same, and/or invoiceId → purchase invoice
   * - Legacy: paymentRefNo set with null/blank paymentFor, or note containing ref
   */
  private purchasePaymentWhere(
    tenantId: string,
    reference: string,
    invoiceId: string | null,
  ): Prisma.PaymentWhereInput {
    const ref = reference.trim();
    const refEquals = { equals: ref, mode: 'insensitive' as const };
    return {
      tenantId,
      deletedAt: null,
      OR: [
        {
          paymentFor: { equals: 'purchase', mode: 'insensitive' },
          paymentRefNo: refEquals,
        },
        {
          paymentRefNo: refEquals,
          paymentFor: null,
        },
        ...(invoiceId
          ? [{ invoiceId }]
          : []),
        {
          note: { contains: ref, mode: 'insensitive' },
          OR: [
            { paymentFor: { equals: 'purchase', mode: 'insensitive' } },
            { paymentFor: null },
          ],
        },
      ],
    };
  }

  private async purchaseInvoiceId(
    movementId: string,
    tenantId: string,
  ): Promise<string | null> {
    const inv = await this.tenantDb.db.invoice.findFirst({
      where: { tenantId, stockMovementId: movementId, deletedAt: null },
      select: { id: true },
    });
    return inv?.id ?? null;
  }

  private async listPurchasePaymentRows(movementId: string, reference: string) {
    const tenantId = this.tenantDb.requireTenantId();
    const invoiceId = await this.purchaseInvoiceId(movementId, tenantId);
    return this.tenantDb.db.payment.findMany({
      where: this.purchasePaymentWhere(tenantId, reference, invoiceId),
      include: { account: { select: { name: true } } },
      orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Purchase/view modal: movement + payments + supplier (sequential DB). */
  async getView(id: string): Promise<PurchaseViewBundle> {
    const tenantId = this.tenantDb.requireTenantId();
    const row = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Movement not found');
    const movement = serializeMovement(row);

    const paymentRows = await this.listPurchasePaymentRows(
      row.id,
      row.reference,
    );
    const payments = paymentRows.map((payment) => ({
      id: payment.id,
      amount: toNumber(payment.amount),
      currency: payment.currency,
      method: payment.method,
      paymentRefNo: payment.paymentRefNo,
      paidOn: payment.paidOn ? toIso(payment.paidOn) : null,
      note: payment.note,
      accountId: payment.accountId,
      accountName: payment.account?.name ?? null,
      createdByName: payment.createdByName,
    }));

    let supplier: PurchaseViewBundle['supplier'] = null;
    if (row.supplierId) {
      const supplierRow = await this.tenantDb.db.supplier.findFirst({
        where: { id: row.supplierId, tenantId, deletedAt: null },
      });
      if (supplierRow) {
        supplier = {
          id: supplierRow.id,
          tenantId: supplierRow.tenantId,
          name: supplierRow.name,
          contactName: supplierRow.contactName,
          email: supplierRow.email,
          phone: supplierRow.phone,
          address: supplierRow.address,
          locationCode: supplierRow.locationCode,
          notes: supplierRow.notes,
          taxNumber: supplierRow.taxNumber,
          openingBalance: supplierRow.openingBalance
            ? toNumber(supplierRow.openingBalance)
            : undefined,
          assignedToUserId: supplierRow.assignedToUserId,
          assignedToName: null,
          createdByUserId: supplierRow.createdByUserId,
          createdByName: supplierRow.createdByName,
          createdAt: toIso(supplierRow.createdAt),
          updatedAt: toIso(supplierRow.updatedAt),
          category: 'General',
          leadTimeDays: 7,
          location: supplierRow.locationCode ?? supplierRow.address ?? '—',
          rating: 4.5,
          contactId: supplierRow.id.slice(0, 8).toUpperCase(),
          businessName: supplierRow.name,
          payTerm: null,
          totalPurchase: toNumber(supplierRow.totalPurchase ?? 0),
          totalPurchaseDue: toNumber(supplierRow.totalPurchaseDue ?? 0),
          totalPurchasePaid: toNumber(supplierRow.totalPurchasePaid ?? 0),
          totalPurchaseReturn: toNumber(supplierRow.totalPurchaseReturn ?? 0),
          totalAdvance: toNumber(supplierRow.totalAdvance ?? 0),
          status:
            supplierRow.status === 'inactive' ? 'inactive' : 'active',
        };
      }
    }

    return { movement, payments, supplier };
  }

  async updateStatus(id: string, status: MovementStatus) {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Movement not found');

    const lines = parseMovementLines(existing.lines);
    const applyInbound =
      existing.type === 'inbound' &&
      shouldApplyInboundQty(existing.status, status);
    const applyOutbound =
      existing.type === 'outbound' &&
      shouldApplyOutboundQty(existing.status, status);

    const inboundCost =
      applyInbound && status === 'Received'
        ? lines.reduce((sum, line) => {
            const unitCost = (line as { unitCost?: number }).unitCost ?? 0;
            return sum + unitCost * line.quantity;
          }, 0)
        : 0;

    const catalogOnly = await this.skipsLocalStock(tenantId);
    const tenantCtx = await this.tenantStockContext(tenantId);

    if (applyInbound || applyOutbound) {
      const db = this.prisma.forTenant(tenantId);
      await db.$transaction(async (tx) => {
        if (!catalogOnly) {
          for (const line of lines) {
            const item = await resolveActiveItem(tx, {
              tenantId,
              itemId: line.itemId,
              sku: line.sku,
            });
            if (!item) {
              throw new BadRequestException(
                `Item not found: ${line.sku || line.itemId}`,
              );
            }
            if (
              !shouldAdjustLocalItemStock(tenantCtx, {
                name: line.name || item.name,
                sku: item.sku || line.sku,
                category: item.category,
              })
            ) {
              continue;
            }

            const delta = applyInbound ? line.quantity : -line.quantity;
            const nextQuantity = item.quantity + delta;
            if (nextQuantity < 0) {
              throw new BadRequestException(
                `Insufficient stock for ${line.sku || item.sku} (need ${line.quantity}, have ${item.quantity})`,
              );
            }

            await tx.item.update({
              where: { id: item.id },
              data: {
                quantity: nextQuantity,
                status: computeStockStatus(nextQuantity, item.reorderPoint),
              },
            });

            await adjustItemLocationStock(tx, {
              tenantId,
              itemId: item.id,
              locationCode: existing.locationCode ?? item.locationCode,
              binLocation: item.binLocation,
              delta,
            });
          }
        }

        await tx.stockMovement.update({
          where: { id },
          data: { status },
        });

        if (applyInbound && status === 'Received') {
          const movementWithSupplier = await tx.stockMovement.findFirst({
            where: { id, tenantId },
            include: { supplier: { select: { name: true } } },
          });
          const invoice = movementWithSupplier
            ? await this.invoiceHub.ensurePurchaseInvoice(tx, {
                ...movementWithSupplier,
                status,
              })
            : null;

          const totalCost = inboundCost;
          if (totalCost > 0) {
            await tx.ledgerEntry.create({
              data: {
                tenantId,
                type: 'cost',
                amount: totalCost,
                currency: 'NGN',
                category: 'Purchases',
                description: `Inbound ${existing.reference}`,
                linkedRecordType: 'stock_movement',
                linkedRecordId: id,
                date: existing.date,
                invoiceId: invoice?.id ?? null,
              },
            });
          }
        }
      });
      if (inboundCost > 0) {
        void applyDailyFinanceDelta(
          this.prisma,
          tenantId,
          existing.date,
          'cost',
          inboundCost,
        );
      }
    } else {
      await this.tenantDb.db.stockMovement.update({
        where: { id },
        data: { status },
      });
    }

    const row = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Movement not found');
    await this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: id,
      summary: `Status → ${status}`,
      metadata: { previousStatus: existing.status, status },
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    if (existing.supplierId) {
      void refreshSupplierPurchaseRollups(this.tenantDb.db, existing.supplierId);
    }
    return serializeMovement(row);
  }

  /** Soft-delete purchase/movement (HQ6 Delete → Are you sure?). */
  async remove(id: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true, supplierId: true },
    });
    if (!existing) throw new NotFoundException('Movement not found');

    await this.tenantDb.db.$transaction(async (tx) => {
      await this.archiveReplacedPurchaseInTx(tx, {
        movementId: id,
        tenantId,
      });
    }, PURCHASE_TX_OPTIONS);

    if (existing.supplierId) {
      await refreshSupplierPurchaseRollups(
        this.tenantDb.db,
        existing.supplierId,
      );
    }

    await this.auditService.log({
      action: 'deleted',
      entityType: 'stockMovement',
      entityId: id,
      summary: `Deleted movement ${existing.reference}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
  }

  /**
   * Soft-delete a purchase being replaced/deleted and free Invoice unique
   * `(tenantId, reference, kind)` so a replacement can reuse the PO number.
   */
  private async archiveReplacedPurchaseInTx(
    tx: Prisma.TransactionClient,
    opts: { movementId: string; tenantId: string },
  ): Promise<{ supplierId: string | null; reference: string }> {
    const existing = await tx.stockMovement.findFirst({
      where: {
        id: opts.movementId,
        tenantId: opts.tenantId,
        deletedAt: null,
      },
      select: { id: true, reference: true, supplierId: true },
    });
    if (!existing) {
      throw new NotFoundException('Purchase to replace was not found');
    }

    const invoice = await tx.invoice.findFirst({
      where: {
        tenantId: opts.tenantId,
        stockMovementId: opts.movementId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const invoiceId = invoice?.id ?? null;

    const payments = await tx.payment.findMany({
      where: this.purchasePaymentWhere(
        opts.tenantId,
        existing.reference,
        invoiceId,
      ),
      select: { id: true },
    });
    for (const payment of payments) {
      await softDeletePaymentAccountTxns(tx, {
        tenantId: opts.tenantId,
        paymentId: payment.id,
      });
    }
    if (payments.length > 0) {
      await tx.payment.updateMany({
        where: { id: { in: payments.map((p) => p.id) } },
        data: { deletedAt: new Date() },
      });
    }

    await tx.ledgerEntry.updateMany({
      where: {
        tenantId: opts.tenantId,
        linkedRecordType: 'stock_movement',
        linkedRecordId: opts.movementId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    if (invoiceId || payments.length > 0) {
      await tx.accountTransaction.updateMany({
        where: {
          tenantId: opts.tenantId,
          deletedAt: null,
          OR: [
            ...(invoiceId ? [{ invoiceId }] : []),
            ...(payments.length > 0
              ? [{ paymentId: { in: payments.map((p) => p.id) } }]
              : []),
          ],
        },
        data: { deletedAt: new Date() },
      });
    }

    const archivedRef = `${existing.reference}__del_${opts.movementId.slice(-8)}`;
    await tx.invoice.updateMany({
      where: {
        tenantId: opts.tenantId,
        stockMovementId: opts.movementId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
        reference: archivedRef,
      },
    });

    await tx.stockMovement.update({
      where: { id: opts.movementId },
      data: {
        deletedAt: new Date(),
        reference: archivedRef,
      },
    });

    return { supplierId: existing.supplierId, reference: existing.reference };
  }

  /** Pay against a single inbound purchase (HQ6 purchases “Add payment”). */
  async pay(
    id: string,
    dto: PayContactDueRequest,
  ): Promise<{
    movementId: string;
    amountApplied: number;
    currency: string;
    remainingDue: number;
    paymentStatus: string;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    const accountId = dto.accountId?.trim() || null;
    if (!accountId) {
      throw new BadRequestException(
        'Select a Payment Account so this payment posts to the account book',
      );
    }

    const movement = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null, type: 'inbound' },
    });
    if (!movement) throw new NotFoundException('Purchase not found');

    const total = movementLineRollups(movement.lines).grandTotal;
    if (total <= 0) {
      throw new BadRequestException('Purchase has no payable amount');
    }
    if (movement.paymentStatus === 'paid') {
      throw new BadRequestException('Purchase is already paid');
    }

    const invoiceId = await this.purchaseInvoiceId(id, tenantId);
    const priorPaid = await this.tenantDb.db.payment.aggregate({
      where: this.purchasePaymentWhere(
        tenantId,
        movement.reference,
        invoiceId,
      ),
      _sum: { amount: true },
    });
    const alreadyPaid = toNumber(priorPaid._sum.amount ?? 0);
    const due = Math.max(0, total - alreadyPaid);
    if (due <= 0) {
      throw new BadRequestException('No outstanding due on this purchase');
    }

    const apply = Math.min(amount, due);
    const paidOn = dto.paidOn ? new Date(dto.paidOn) : new Date();
    const method = dto.method?.trim() || 'cash';
    const createdBy = await this.auditService.createdByFields();

    const paymentId = await this.tenantDb.db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          amount: apply,
          currency: 'NGN',
          method,
          paidOn,
          paymentFor: 'purchase',
          paymentRefNo: movement.reference,
          invoiceId,
          accountId,
          note:
            dto.note?.trim() ||
            `Purchase payment — ${movement.reference}`,
          createdByName: createdBy.createdByName ?? null,
        },
      });

      await recordPaymentAccountTxn(tx, {
        tenantId,
        accountId,
        type: 'debit',
        subType: 'purchase_payment',
        amount: apply,
        operationDate: paidOn,
        refNo: movement.reference,
        note:
          dto.note?.trim() ||
          `Purchase payment — ${movement.reference}`,
        paymentMethod: method,
        paymentId: payment.id,
        createdByName: createdBy.createdByName ?? null,
      });

      const newPaid = alreadyPaid + apply;
      const paymentStatus = newPaid >= total - 0.001 ? 'paid' : 'partial';
      await tx.stockMovement.update({
        where: { id },
        data: {
          paymentStatus,
          paymentMethod: method,
          totalPaid: newPaid,
        },
      });
      return payment.id;
    });

    if (movement.supplierId) {
      await refreshSupplierPurchaseRollups(
        this.tenantDb.db,
        movement.supplierId,
      );
    }

    const remainingDue = Math.max(0, due - apply);
    await this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: id,
      summary: `Recorded payment of ${apply} on ${movement.reference}`,
      metadata: { paymentId, amount: apply },
    });
    await this.auditService.log({
      action: 'created',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Purchase payment ${apply} on ${movement.reference}`,
      metadata: {
        amount: apply,
        movementId: id,
        reference: movement.reference,
      },
    });

    return {
      movementId: id,
      amountApplied: apply,
      currency: 'NGN',
      remainingDue,
      paymentStatus: remainingDue <= 0 ? 'paid' : 'partial',
    };
  }

  async listPayments(id: string): Promise<
    Array<{
      id: string;
      amount: number;
      currency: string;
      method: string | null;
      paymentRefNo: string | null;
      paidOn: string | null;
      note: string | null;
      accountId: string | null;
      accountName: string | null;
      createdByName: string | null;
    }>
  > {
    const tenantId = this.tenantDb.requireTenantId();
    const movement = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, reference: true },
    });
    if (!movement) throw new NotFoundException('Movement not found');

    const rows = await this.listPurchasePaymentRows(
      movement.id,
      movement.reference,
    );

    return rows.map((row) => ({
      id: row.id,
      amount: toNumber(row.amount),
      currency: row.currency,
      method: row.method,
      paymentRefNo: row.paymentRefNo,
      paidOn: row.paidOn ? toIso(row.paidOn) : null,
      note: row.note,
      accountId: row.accountId,
      accountName: row.account?.name ?? null,
      createdByName: row.createdByName,
    }));
  }

  private async syncPurchasePaymentStatus(
    movementId: string,
    tenantId: string,
    reference: string,
    supplierId: string | null,
  ) {
    const movement = await this.tenantDb.db.stockMovement.findFirst({
      where: { id: movementId, tenantId, deletedAt: null },
    });
    if (!movement) return;

    const total = movementLineRollups(movement.lines).grandTotal;
    const invoiceId = await this.purchaseInvoiceId(movementId, tenantId);
    const paidAgg = await this.tenantDb.db.payment.aggregate({
      where: this.purchasePaymentWhere(tenantId, reference, invoiceId),
      _sum: { amount: true },
    });
    const paid = toNumber(paidAgg._sum.amount ?? 0);
    const paymentStatus = paymentStatusFromAmounts(
      total,
      paid,
      movement.paymentStatus,
    ) as PurchasePaymentStatus;

    await this.tenantDb.db.stockMovement.update({
      where: { id: movementId },
      data: { paymentStatus, totalPaid: paid },
    });

    if (supplierId) {
      await refreshSupplierPurchaseRollups(this.tenantDb.db, supplierId);
    }
    // Await list bust before pay APIs return — otherwise React Query refetch
    // can hit a stale purchases page and flip Paid → Due.
    await invalidateTenantDashboardCache(this.cache, tenantId);
    await invalidateTenantListCache(this.cache, tenantId, [
      'stock-movements:v3',
      'stock-movements:v2',
      'stock-movements',
    ]);
  }

  /**
   * Recompute totalPaid + paymentStatus for all inbound purchases in scope.
   * Fixes list "Due" when Payment rows exist but the cache was never updated.
   */
  async resyncPurchasePaymentCaches(): Promise<{
    scanned: number;
    updated: number;
  }> {
    const tenantId = this.tenantDb.requireTenantId();
    const moves = await this.tenantDb.db.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        type: 'inbound',
        ...excludeOpeningStockPurchasesWhere(),
      },
      select: {
        id: true,
        reference: true,
        paymentStatus: true,
        totalPaid: true,
        grandTotal: true,
        supplierId: true,
        lines: true,
      },
    });

    let updated = 0;
    for (const m of moves) {
      const invoiceId = await this.purchaseInvoiceId(m.id, tenantId);
      const paidAgg = await this.tenantDb.db.payment.aggregate({
        where: this.purchasePaymentWhere(tenantId, m.reference, invoiceId),
        _sum: { amount: true },
      });
      const paid = toNumber(paidAgg._sum.amount ?? 0);
      const total =
        m.grandTotal != null
          ? toNumber(m.grandTotal)
          : movementLineRollups(m.lines).grandTotal;
      const nextStatus = paymentStatusFromAmounts(
        total,
        paid,
        m.paymentStatus,
      ) as PurchasePaymentStatus;
      const stored = toNumber(m.totalPaid);
      if (Math.abs(paid - stored) <= 0.01 && m.paymentStatus === nextStatus) {
        continue;
      }
      await this.tenantDb.db.stockMovement.update({
        where: { id: m.id },
        data: { totalPaid: paid, paymentStatus: nextStatus },
      });
      if (m.supplierId) {
        await refreshSupplierPurchaseRollups(this.tenantDb.db, m.supplierId);
      }
      updated += 1;
    }
    void invalidateTenantDashboardCache(this.cache, tenantId);
    return { scanned: moves.length, updated };
  }

  async updatePayment(
    movementId: string,
    paymentId: string,
    body: {
      amount?: number;
      method?: string | null;
      note?: string | null;
      paidOn?: string | null;
      accountId?: string | null;
      paymentRefNo?: string | null;
    },
  ) {
    const tenantId = this.tenantDb.requireTenantId();
    const movement = await this.tenantDb.db.stockMovement.findFirst({
      where: { id: movementId, tenantId, deletedAt: null, type: 'inbound' },
      select: { id: true, reference: true, supplierId: true },
    });
    if (!movement) throw new NotFoundException('Purchase not found');

    const invoiceId = await this.purchaseInvoiceId(movementId, tenantId);
    const payment = await this.tenantDb.db.payment.findFirst({
      where: {
        id: paymentId,
        ...this.purchasePaymentWhere(tenantId, movement.reference, invoiceId),
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    const amount =
      body.amount !== undefined ? Number(body.amount) : toNumber(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter a valid payment amount');
    }
    const accountId =
      body.accountId !== undefined
        ? body.accountId?.trim() || null
        : payment.accountId;
    if (!accountId) {
      throw new BadRequestException(
        'Select a Payment Account so this payment posts to the account book',
      );
    }

    const updated = await this.tenantDb.db.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: paymentId },
        data: {
          amount,
          ...(body.method !== undefined
            ? { method: body.method?.trim() || null }
            : {}),
          ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
          ...(body.paidOn !== undefined
            ? { paidOn: body.paidOn ? new Date(body.paidOn) : null }
            : {}),
          accountId,
          // Keep purchase link on movement.reference — never overwrite with a
          // display-only payment receipt number from the edit form.
        },
        include: { account: { select: { name: true } } },
      });

      await syncPurchasePaymentAccountDebit(tx, {
        tenantId,
        paymentId: row.id,
        accountId: row.accountId,
        amount: toNumber(row.amount),
        operationDate: row.paidOn ?? row.createdAt,
        refNo: movement.reference,
        note: row.note ?? `Purchase payment — ${movement.reference}`,
        paymentMethod: row.method,
        createdByName: row.createdByName,
      });

      return row;
    });

    await this.syncPurchasePaymentStatus(
      movementId,
      tenantId,
      movement.reference,
      movement.supplierId,
    );

    void this.auditService.log({
      action: 'updated',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Updated purchase payment on ${movement.reference}`,
      metadata: { amount, movementId, reference: movement.reference },
    });
    void this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: movementId,
      summary: `Updated payment on ${movement.reference}`,
      metadata: { paymentId, amount },
    });

    return {
      id: updated.id,
      amount: toNumber(updated.amount),
      currency: updated.currency,
      method: updated.method,
      paymentRefNo: updated.paymentRefNo,
      paidOn: updated.paidOn ? toIso(updated.paidOn) : null,
      note: updated.note,
      accountId: updated.accountId,
      accountName: updated.account?.name ?? null,
      createdByName: updated.createdByName,
    };
  }

  async removePayment(movementId: string, paymentId: string): Promise<void> {
    const tenantId = this.tenantDb.requireTenantId();
    const movement = await this.tenantDb.db.stockMovement.findFirst({
      where: { id: movementId, tenantId, deletedAt: null, type: 'inbound' },
      select: { id: true, reference: true, supplierId: true },
    });
    if (!movement) throw new NotFoundException('Purchase not found');

    const invoiceId = await this.purchaseInvoiceId(movementId, tenantId);
    const payment = await this.tenantDb.db.payment.findFirst({
      where: {
        id: paymentId,
        ...this.purchasePaymentWhere(tenantId, movement.reference, invoiceId),
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    await this.tenantDb.db.$transaction(async (tx) => {
      await softDeletePaymentAccountTxns(tx, { tenantId, paymentId });
      await tx.payment.update({
        where: { id: paymentId },
        data: { deletedAt: new Date() },
      });
    });

    await this.syncPurchasePaymentStatus(
      movementId,
      tenantId,
      movement.reference,
      movement.supplierId,
    );

    void this.auditService.log({
      action: 'deleted',
      entityType: 'payment',
      entityId: paymentId,
      summary: `Deleted purchase payment on ${movement.reference}`,
      metadata: { movementId, reference: movement.reference },
    });
    void this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: movementId,
      summary: `Removed payment from ${movement.reference}`,
      metadata: { paymentId },
    });
  }

  async create(body: {
    type: MovementType;
    reference: string;
    status?: MovementStatus;
    paymentStatus?: PurchasePaymentStatus;
    paymentMethod?: string;
    lines: Array<{
      itemId: string;
      sku: string;
      name: string;
      quantity: number;
      unitCost?: number;
      discountPercent?: number;
      unitSellingPrice?: number;
      expDate?: string;
    }>;
    notes?: string;
    locationCode?: string;
    supplierId?: string;
    source?: MovementSource;
    date?: string;
  }) {
    const tenantId = this.tenantDb.requireTenantId();
    const [createdBy, locationCode, tenantCtx] = await Promise.all([
      this.auditService.createdByFields(),
      this.tenantDb.resolveBusinessLocation(body.locationCode),
      this.tenantStockContext(tenantId),
    ]);
    const rollups = movementLineRollups(body.lines);
    const initialStatus = body.status ?? 'Ordered';
    const row = await this.tenantDb.db.stockMovement.create({
      data: {
        tenantId,
        type: body.type,
        reference: body.reference,
        status: initialStatus,
        paymentStatus: body.paymentStatus ?? null,
        paymentMethod: body.paymentMethod?.trim() || null,
        lines: body.lines as unknown as import('@prisma/client').Prisma.InputJsonValue,
        itemCount: rollups.itemCount,
        grandTotal: rollups.grandTotal,
        notes: body.notes ?? null,
        supplierId: body.supplierId ?? null,
        source: body.source ?? 'standard',
        locationCode,
        date: body.date ? new Date(body.date) : new Date(),
        ...createdBy,
      },
      include: { supplier: { select: { name: true } } },
    });

    // Default purchase UI saves as Received — apply stock once on create.
    // (updateStatus only runs on later status changes.)
    // VA / VP catalog-only tenants: purchases are billing records, not stock receipts.
    const catalogOnly = !shouldAdjustLocalItemStock(tenantCtx, null);
    if (
      !catalogOnly &&
      body.type === 'inbound' &&
      shouldApplyInboundQty('Ordered', initialStatus)
    ) {
      const db = this.prisma.forTenant(tenantId);
      await db.$transaction(async (tx) => {
        await applyInboundStockDeltas(tx, {
          tenantId,
          tenant: tenantCtx,
          qtyByItem: movementLineQtyByItemId(body.lines),
          lineLookup: inboundStockLineLookup(body.lines),
          locationCode,
        });
      }, PURCHASE_TX_OPTIONS);
    }

    if (body.type === 'inbound') {
      // Invoice hub is not required for the create response — defer like expenses.
      void this.invoiceHub
        .ensurePurchaseInvoice(this.tenantDb.db, row)
        .catch((err: unknown) => {
          console.error('[purchases] ensurePurchaseInvoice failed', err);
        });
    }
    void this.auditService.log({
      action: 'created',
      entityType: 'stockMovement',
      entityId: row.id,
      summary: `Created ${body.type} movement ${row.reference}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    if (row.supplierId) {
      void refreshSupplierPurchaseRollups(this.tenantDb.db, row.supplierId);
    }
    return serializeMovement(row);
  }

  /** In-place purchase edit — same id, update invoice; keep existing payments. */
  async update(
    id: string,
    body: {
      type?: MovementType;
      reference?: string;
      status?: MovementStatus;
      paymentStatus?: PurchasePaymentStatus;
      paymentMethod?: string;
      lines?: Array<{
        itemId: string;
        sku: string;
        name: string;
        quantity: number;
        unitCost?: number;
        discountPercent?: number;
        unitSellingPrice?: number;
        expDate?: string;
      }>;
      notes?: string;
      locationCode?: string;
      supplierId?: string;
      source?: MovementSource;
      date?: string;
    },
  ) {
    const tenantId = this.tenantDb.requireTenantId();
    const existing = await this.tenantDb.db.stockMovement.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { supplier: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundException('Movement not found');

    const nextLines = body.lines ?? parseMovementLines(existing.lines);
    const rollups = movementLineRollups(nextLines);
    const locationCode =
      body.locationCode !== undefined
        ? await this.tenantDb.resolveBusinessLocation(body.locationCode)
        : existing.locationCode;
    const nextStatus = body.status ?? existing.status;
    const nextReference = body.reference?.trim() || existing.reference;
    const nextPaymentStatus =
      body.paymentStatus !== undefined
        ? body.paymentStatus
        : existing.paymentStatus;
    const nextSupplierId =
      body.supplierId !== undefined ? body.supplierId : existing.supplierId;
    const nextDate = body.date ? new Date(body.date) : existing.date;
    const nextNotes =
      body.notes !== undefined ? body.notes : existing.notes;

    const prevLines = parseMovementLines(existing.lines);
    const wasReceived = existing.status === 'Received';
    const willReceive = nextStatus === 'Received';
    const prevFullLines = Array.isArray(existing.lines)
      ? (existing.lines as Array<Record<string, unknown>>)
      : [];
    const linesJsonChanged = !purchaseLinesEqual(
      prevFullLines.map((line) => ({
        itemId: String(line.itemId ?? ''),
        sku: String(line.sku ?? ''),
        name: String(line.name ?? ''),
        quantity: Number(line.quantity ?? 0),
        unitCost:
          line.unitCost === undefined || line.unitCost === null
            ? undefined
            : Number(line.unitCost),
        discountPercent:
          line.discountPercent === undefined || line.discountPercent === null
            ? undefined
            : Number(line.discountPercent),
        unitSellingPrice:
          line.unitSellingPrice === undefined || line.unitSellingPrice === null
            ? undefined
            : Number(line.unitSellingPrice),
        expDate: typeof line.expDate === 'string' ? line.expDate : undefined,
      })),
      nextLines.map((line) => ({
        itemId: line.itemId,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
        unitCost: line.unitCost,
        discountPercent: (line as { discountPercent?: number }).discountPercent,
        unitSellingPrice: (line as { unitSellingPrice?: number })
          .unitSellingPrice,
        expDate: line.expDate,
      })),
    );

    const nextPaymentMethod =
      body.paymentMethod !== undefined
        ? body.paymentMethod?.trim() || null
        : existing.paymentMethod;
    const headerChanged = purchaseHeaderChanged(
      {
        reference: existing.reference,
        status: existing.status,
        supplierId: existing.supplierId,
        locationCode: existing.locationCode,
        dateIso: existing.date.toISOString(),
        notes: existing.notes,
        paymentMethod: existing.paymentMethod,
        paymentStatus: existing.paymentStatus,
      },
      {
        reference: nextReference,
        status: nextStatus,
        supplierId: nextSupplierId ?? null,
        locationCode: locationCode ?? null,
        dateIso: nextDate.toISOString(),
        notes: nextNotes ?? null,
        paymentMethod: nextPaymentMethod,
        paymentStatus: nextPaymentStatus ?? null,
      },
    );

    const catalogOnly = await this.skipsLocalStock(tenantId);
    const tenantCtx = await this.tenantStockContext(tenantId);
    const stockDeltas =
      !catalogOnly &&
      existing.type === 'inbound' &&
      (wasReceived || willReceive)
        ? inboundReceiptStockDelta({
            wasReceived,
            willReceive,
            prevLines,
            nextLines,
          })
        : new Map<string, number>();
    const needsStock = stockDeltas.size > 0;
    const needsInvoice =
      existing.type === 'inbound' && (headerChanged || linesJsonChanged);
    const needsMovementWrite =
      headerChanged ||
      linesJsonChanged ||
      body.type !== undefined ||
      body.source !== undefined;

    // No-op edit (notes/lines/header/stock all identical) — skip DB write.
    if (!needsMovementWrite && !needsStock) {
      return serializeMovement(existing);
    }

    let row: Awaited<
      ReturnType<Prisma.TransactionClient['stockMovement']['update']>
    > & { supplier: { name: string } | null };
    try {
      if (needsStock) {
        row = await this.tenantDb.db.$transaction(async (tx) => {
          await applyInboundStockDeltas(tx, {
            tenantId,
            tenant: tenantCtx,
            qtyByItem: stockDeltas,
            lineLookup: inboundStockLineLookup(nextLines),
            locationCode,
          });
          return tx.stockMovement.update({
            where: { id },
            data: {
              ...(body.type ? { type: body.type } : {}),
              reference: nextReference,
              status: nextStatus,
              paymentStatus: nextPaymentStatus,
              ...(body.paymentMethod !== undefined
                ? { paymentMethod: body.paymentMethod?.trim() || null }
                : {}),
              lines: nextLines as unknown as import('@prisma/client').Prisma.InputJsonValue,
              itemCount: rollups.itemCount,
              grandTotal: rollups.grandTotal,
              notes: nextNotes ?? null,
              supplierId: nextSupplierId ?? null,
              ...(body.source ? { source: body.source } : {}),
              locationCode,
              date: nextDate,
            },
            include: { supplier: { select: { name: true } } },
          });
        }, PURCHASE_TX_OPTIONS);
      } else {
        row = await this.tenantDb.db.stockMovement.update({
          where: { id },
          data: {
            ...(body.type ? { type: body.type } : {}),
            reference: nextReference,
            status: nextStatus,
            paymentStatus: nextPaymentStatus,
            ...(body.paymentMethod !== undefined
              ? { paymentMethod: body.paymentMethod?.trim() || null }
              : {}),
            ...(linesJsonChanged
              ? {
                  lines:
                    nextLines as unknown as import('@prisma/client').Prisma.InputJsonValue,
                  itemCount: rollups.itemCount,
                  grandTotal: rollups.grandTotal,
                }
              : {}),
            notes: nextNotes ?? null,
            supplierId: nextSupplierId ?? null,
            ...(body.source ? { source: body.source } : {}),
            locationCode,
            date: nextDate,
          },
          include: { supplier: { select: { name: true } } },
        });
      }
    } catch (error) {
      if (
        error instanceof PrismaRuntime.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      ) {
        throw new BadRequestException(
          'Purchase update timed out — please try again',
        );
      }
      throw error;
    }

    if (needsInvoice) {
      await this.invoiceHub.ensurePurchaseInvoice(this.tenantDb.db, row);
    }

    void this.auditService.log({
      action: 'updated',
      entityType: 'stockMovement',
      entityId: row.id,
      summary: `Updated ${row.type} movement ${row.reference}`,
    });
    void invalidateTenantDashboardCache(this.cache, tenantId);
    const supplierIds = new Set<string>();
    if (existing.supplierId) supplierIds.add(existing.supplierId);
    if (row.supplierId) supplierIds.add(row.supplierId);
    for (const supplierId of supplierIds) {
      void refreshSupplierPurchaseRollups(this.tenantDb.db, supplierId);
    }
    return serializeMovement(row);
  }

  async listTransfers(filters: {
    cursor?: string;
    limit?: number;
    search?: string;
    from?: string;
    to?: string;
    status?: string;
  }): Promise<TransferRow[]> {
    const tenantId = this.tenantDb.requireTenantId();
    const pagination = buildCompositeCursorQuery({
      sortField: 'date',
      sortDir: 'desc',
      cursor: filters.cursor,
      limit: filters.limit ?? 10,
      sortValueType: 'date',
    });
    const statusIn = transferDbStatuses(filters.status);
    const rows = await this.tenantDb.db.stockMovement.findMany({
      where: {
        tenantId,
        deletedAt: null,
        type: 'transfer',
        ...(statusIn ? { status: { in: statusIn } } : {}),
        ...(filters.from || filters.to
          ? {
              date: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
        ...(transferTextSearchWhere(filters.search) ?? {}),
        ...(pagination.where ?? {}),
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: pagination.take,
    });
    return rows.map(toTransferRow);
  }

  async transferZones(): Promise<TransferZoneSummary[]> {
    const tenantId = this.tenantDb.requireTenantId();
    type ZoneAgg = {
      zone: string;
      total_skus: bigint;
      total_units: bigint;
    };
    const zoneRows = await this.tenantDb.db.$queryRaw<ZoneAgg[]>`
      SELECT
        COALESCE(
          NULLIF(TRIM(SPLIT_PART("binLocation", '-', 1)), ''),
          'Main Warehouse'
        ) AS zone,
        COUNT(*)::bigint AS total_skus,
        COALESCE(SUM(quantity), 0)::bigint AS total_units
      FROM "Item"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const pendingTotal = await this.tenantDb.db.stockMovement.count({
      where: {
        tenantId,
        deletedAt: null,
        type: 'transfer',
        status: 'Pending',
      },
    });

    if (zoneRows.length === 0) {
      return [
        {
          id: 'main',
          name: 'Main Warehouse',
          totalSkus: 0,
          totalUnits: 0,
          pendingTransfers: pendingTotal,
          utilizationPercent: 0,
        },
      ];
    }

    const maxUnits = Math.max(
      ...zoneRows.map((row: ZoneAgg) => Number(row.total_units)),
      1,
    );

    return zoneRows.map((row: ZoneAgg) => {
      const totalUnits = Number(row.total_units);
      return {
        id: row.zone.toLowerCase().replace(/\s+/g, '-'),
        name: row.zone,
        totalSkus: Number(row.total_skus),
        totalUnits,
        pendingTransfers: pendingTotal,
        utilizationPercent: Math.min(
          100,
          Math.round((totalUnits / maxUnits) * 100),
        ),
      };
    });
  }
}

/** Boot/cron: seed default inbound purchase list caches. */
export async function warmDefaultStockMovementListPages(
  prisma: import('@prisma/client').PrismaClient,
  cache: CacheService,
  tenantId: string,
): Promise<void> {
  for (const limit of HQ6_LIST_WARM_LIMITS) {
    for (const sort of hq6WarmSorts({ sortBy: 'updatedAt', sortDir: 'desc' })) {
      for (const includeSummary of [false, true] as const) {
        const filterKey = listPageFilterKey({
          type: 'inbound',
          status: undefined,
          source: undefined,
          locationCode: undefined,
          supplierId: undefined,
          paymentStatus: undefined,
          paymentMethod: undefined,
          search: undefined,
          from: undefined,
          to: undefined,
          cursor: undefined,
          limit,
          sortBy: sort.sortBy,
          sortDir: sort.sortDir,
          sum: includeSummary ? 1 : 0,
        });
        await withListPageCache(
          cache,
          tenantId,
          'stock-movements:v3',
          filterKey,
          async () => {
            const baseWhere = {
              tenantId,
              deletedAt: null as null,
              type: 'inbound' as const,
              ...excludeOpeningStockPurchasesWhere(),
            };
            const [rows, totalCount] = await Promise.all([
              prisma.stockMovement.findMany({
                where: baseWhere,
                select: {
                  id: true,
                  tenantId: true,
                  type: true,
                  reference: true,
                  status: true,
                  notes: true,
                  locationCode: true,
                  supplierId: true,
                  source: true,
                  paymentStatus: true,
                  paymentMethod: true,
                  totalPaid: true,
                  date: true,
                  itemCount: true,
                  grandTotal: true,
                  createdByUserId: true,
                  createdByName: true,
                  createdAt: true,
                  updatedAt: true,
                  deletedAt: true,
                  supplier: { select: { name: true } },
                },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                take: limit,
              }),
              includeSummary
                ? prisma.stockMovement.count({ where: baseWhere })
                : Promise.resolve(undefined as number | undefined),
            ]);
            return {
              items: rows.map((row) =>
                toMovementListRow({
                  ...row,
                  lines: [],
                }),
              ),
              ...(totalCount != null ? { totalCount } : {}),
            };
          },
          600,
        );
      }
    }
  }
}

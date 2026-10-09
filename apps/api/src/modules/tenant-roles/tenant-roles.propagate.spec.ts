import { TenantRolesService } from './tenant-roles.service';
import { OPERATING_TENANTS } from '../../common/tenants/ensureOperatingTenant';

type RoleRow = {
  id: string;
  tenantId: string;
  name: string;
  permissions: string[];
  isServiceStaff: boolean;
  locked: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const OPERATING = OPERATING_TENANTS.filter((t) => t.code !== 'VAG');
const TENANT_A = OPERATING[0]!.id;
const TENANT_B = OPERATING[1]!.id;
const VAG_ID = 'tenant_vag_001';

function makeRole(
  partial: Partial<RoleRow> & Pick<RoleRow, 'id' | 'tenantId' | 'name'>,
): RoleRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    permissions: [],
    isServiceStaff: false,
    locked: false,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('TenantRolesService propagate (unit)', () => {
  let roles: RoleRow[];
  let idSeq: number;
  let requireTenantId: jest.Mock;
  let service: TenantRolesService;

  beforeEach(() => {
    roles = [];
    idSeq = 1;
    requireTenantId = jest.fn().mockReturnValue(TENANT_A);

    const prisma = {
      tenant: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
          if (where.id) {
            const known = OPERATING_TENANTS.find((t) => t.id === where.id);
            return known ? { id: known.id } : null;
          }
          if (where.code) {
            const known = OPERATING_TENANTS.find((t) => t.code === where.code);
            return known ? { id: known.id } : null;
          }
          return null;
        }),
        create: jest.fn(async () => ({})),
      },
      tenantRole: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return roles.filter((row) => matchesWhere(row, where));
        }),
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          return roles.find((row) => matchesWhere(row, where)) ?? null;
        }),
        create: jest.fn(async ({ data }: { data: Omit<RoleRow, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'> }) => {
          const row = makeRole({
            id: `role_${idSeq++}`,
            tenantId: data.tenantId,
            name: data.name,
            permissions: data.permissions ?? [],
            isServiceStaff: Boolean(data.isServiceStaff),
            locked: Boolean(data.locked),
          });
          roles.push(row);
          return row;
        }),
        createMany: jest.fn(async ({ data }: { data: Array<Partial<RoleRow>> }) => {
          for (const item of data) {
            roles.push(
              makeRole({
                id: `role_${idSeq++}`,
                tenantId: String(item.tenantId),
                name: String(item.name),
                permissions: (item.permissions as string[]) ?? [],
                isServiceStaff: Boolean(item.isServiceStaff),
                locked: Boolean(item.locked),
              }),
            );
          }
          return { count: data.length };
        }),
        update: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<RoleRow>;
          }) => {
            const idx = roles.findIndex((r) => r.id === where.id);
            if (idx < 0) throw new Error(`missing ${where.id}`);
            const next = {
              ...roles[idx]!,
              ...data,
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            };
            roles[idx] = next;
            return next;
          },
        ),
      },
      user: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    };

    const tenantDb = { requireTenantId };
    const cache = {
      bumpTenantVersion: jest.fn(async () => undefined),
      clearL1Matching: jest.fn(),
      del: jest.fn(async () => undefined),
      delByPrefix: jest.fn(),
      invalidatePrefix: jest.fn(async () => undefined),
    };

    service = new TenantRolesService(
      tenantDb as never,
      prisma as never,
      cache as never,
    );

    // Avoid seeded catalog noise — stub ensureDefaults / sync debounce window.
    jest
      .spyOn(service as never, 'ensureDefaults' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'backfillEmptyLegacyPermissions' as never)
      .mockResolvedValue(undefined as never);
  });

  it('create on tenant A also creates the same role on peer tenants', async () => {
    const created = await service.create({
      name: 'Shared Mechanic',
      permissions: ['user.view', 'job.view'],
      isServiceStaff: false,
    });

    expect(created.tenantId).toBe(TENANT_A);
    expect(created.name).toBe('Shared Mechanic');

    // Propagation is fire-and-forget so the HTTP save returns immediately.
    await new Promise((r) => setImmediate(r));

    const peer = roles.find(
      (r) =>
        r.tenantId === TENANT_B &&
        r.name === 'Shared Mechanic' &&
        r.deletedAt === null,
    );
    expect(peer).toBeTruthy();
    expect(peer?.permissions).toEqual(['user.view', 'job.view']);
  });

  it('update permissions propagates to peers but skips locked Admin', async () => {
    const source = makeRole({
      id: 'role_src',
      tenantId: TENANT_A,
      name: 'Parts Clerk',
      permissions: ['user.view'],
    });
    const peer = makeRole({
      id: 'role_peer',
      tenantId: TENANT_B,
      name: 'Parts Clerk',
      permissions: ['user.view'],
    });
    const adminPeer = makeRole({
      id: 'role_admin_peer',
      tenantId: TENANT_B,
      name: 'Admin',
      permissions: [],
      locked: true,
    });
    roles.push(source, peer, adminPeer);

    await service.update('role_src', {
      permissions: ['user.view', 'user.update'],
    });
    await new Promise((r) => setImmediate(r));

    expect(roles.find((r) => r.id === 'role_peer')?.permissions).toEqual([
      'user.view',
      'user.update',
    ]);
    expect(roles.find((r) => r.id === 'role_admin_peer')?.permissions).toEqual(
      [],
    );
  });

  it('delete soft-deletes peers and never deletes Admin', async () => {
    const source = makeRole({
      id: 'role_src',
      tenantId: TENANT_A,
      name: 'Temp Role',
    });
    const peer = makeRole({
      id: 'role_peer',
      tenantId: TENANT_B,
      name: 'Temp Role',
    });
    const admin = makeRole({
      id: 'role_admin',
      tenantId: TENANT_A,
      name: 'Admin',
      locked: true,
    });
    roles.push(source, peer, admin);

    await service.remove('role_src');
    await new Promise((r) => setImmediate(r));

    expect(roles.find((r) => r.id === 'role_src')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(roles.find((r) => r.id === 'role_peer')?.deletedAt).toBeInstanceOf(
      Date,
    );
    expect(roles.find((r) => r.id === 'role_admin')?.deletedAt).toBeNull();
  });

  it('list with VAG tenant id resolves to the operating catalog tenant', async () => {
    requireTenantId.mockReturnValue(VAG_ID);
    const catalogTenant = OPERATING_TENANTS.find((t) => t.code !== 'VAG')!.id;
    roles.push(
      makeRole({
        id: 'role_catalog',
        tenantId: catalogTenant,
        name: 'Catalog Role',
        permissions: ['roles.view'],
      }),
    );

    // Force syncSharedRoleCatalog past debounce by resetting private stamp.
    (service as unknown as { catalogSyncAt: number }).catalogSyncAt = 0;

    const listed = await service.list();
    expect(listed.some((r) => r.name === 'Catalog Role')).toBe(true);
    expect(listed.every((r) => r.tenantId === catalogTenant)).toBe(true);
  });
});

function matchesWhere(
  row: RoleRow,
  where: Record<string, unknown>,
): boolean {
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (typeof where.tenantId === 'string' && row.tenantId !== where.tenantId) {
    return false;
  }
  if (
    where.tenantId &&
    typeof where.tenantId === 'object' &&
    where.tenantId !== null &&
    'in' in (where.tenantId as object)
  ) {
    const ids = (where.tenantId as { in: string[] }).in;
    if (!ids.includes(row.tenantId)) return false;
  }
  if (where.name && typeof where.name === 'object' && where.name !== null) {
    const nameFilter = where.name as {
      equals?: string;
      mode?: string;
      contains?: string;
    };
    if (nameFilter.equals) {
      const left = row.name.toLowerCase();
      const right = nameFilter.equals.toLowerCase();
      if (left !== right) return false;
    }
    if (nameFilter.contains) {
      if (
        !row.name.toLowerCase().includes(nameFilter.contains.toLowerCase())
      ) {
        return false;
      }
    }
  }
  if (where.NOT && typeof where.NOT === 'object' && where.NOT !== null) {
    const not = where.NOT as { id?: string };
    if (not.id && row.id === not.id) return false;
  }
  if (
    where.permissions &&
    typeof where.permissions === 'object' &&
    where.permissions !== null &&
    'isEmpty' in (where.permissions as object)
  ) {
    if ((where.permissions as { isEmpty: boolean }).isEmpty) {
      if (row.permissions.length !== 0) return false;
    }
  }
  return true;
}

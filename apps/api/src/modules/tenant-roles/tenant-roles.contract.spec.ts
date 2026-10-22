import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Contract: shared role definitions propagate across operating entities.
 * Behavioral coverage lives in tenant-roles.propagate.spec.ts.
 */
describe('TenantRolesService shared catalog contract', () => {
  const src = readFileSync(
    join(__dirname, 'tenant-roles.service.ts'),
    'utf8',
  );

  it('maps VAG tenant id to an operating catalog tenant', () => {
    expect(src).toContain('resolveCatalogTenantId');
    expect(src).toContain("tenantId !== 'tenant_vag_001'");
    expect(src).toContain("t.code !== 'VAG'");
  });

  it('propagates create/update/delete to peer tenants by role name', () => {
    expect(src).toContain('propagateRoleToOtherTenants');
    expect(src).toContain('propagateRoleDeleteToOtherTenants');

    const create = src.slice(
      src.indexOf('async create('),
      src.indexOf('async update('),
    );
    // Fire-and-forget so save returns before peer tenants finish.
    expect(create).toContain('void this.propagateRoleToOtherTenants');

    const update = src.slice(
      src.indexOf('async update('),
      src.indexOf('async remove('),
    );
    expect(update).toContain('void this.propagateRoleToOtherTenants');

    const remove = src.slice(
      src.indexOf('async remove('),
      src.indexOf('async importRoles('),
    );
    expect(remove).toContain('void this.propagateRoleDeleteToOtherTenants');
  });

  it('syncs the shared catalog on list and skips locked Admin peers', () => {
    expect(src).toContain('syncSharedRoleCatalog');
    expect(src).toContain('await this.syncSharedRoleCatalog()');
    expect(src).toContain(
      "existing.locked || existing.name.toLowerCase() === 'admin'",
    );
    expect(src).toContain(
      "peer.locked || peer.name.toLowerCase() === 'admin'",
    );
  });

  it('backfills finance keys onto Accountant roles', () => {
    expect(src).toContain('backfillFinanceAuthorizedRolePermissions');
    expect(src).toContain('isFinanceAuthorizedRoleName');
    expect(src).toContain('FINANCE_ROLE_DEFAULT_PERMISSIONS');
  });

  it('gates mutating endpoints with roles.* permission checks', () => {
    const controller = readFileSync(
      join(__dirname, 'tenant-roles.controller.ts'),
      'utf8',
    );
    expect(controller).toContain("roles.create");
    expect(controller).toContain("roles.update");
    expect(controller).toContain("roles.delete");
    expect(controller).toContain('userHasPermission');
    expect(controller).not.toContain("VAG only");
    expect(controller).toContain('create(');
    expect(controller).toContain('update(');
    expect(controller).toContain('remove(');
  });
});
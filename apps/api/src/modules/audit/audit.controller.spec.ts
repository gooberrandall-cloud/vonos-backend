import { readFileSync } from 'fs';
import { join } from 'path';

describe('AuditController', () => {
  it('declares jwt, tenant, and roles guards', () => {
    const src = readFileSync(join(__dirname, 'audit.controller.ts'), 'utf8');
    expect(src).toContain(
      '@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)',
    );
  });
});

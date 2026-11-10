import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantConfig, UpdateTenantConfigRequest } from '@vonos/types';
import {
  catalogPresetsForCode,
  mergeHq6BusinessSettings,
  mergeHrmSettings,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';

function withLocationPresets(config: TenantConfig): TenantConfig {
  const locs = config.businessLocations ?? [];
  if (locs.length > 0) return config;
  const presets = catalogPresetsForCode(config.code).businessLocations ?? [];
  if (presets.length === 0) return config;
  return { ...config, businessLocations: presets };
}

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(
    tenantId: string,
    requesterTenantId: string | null,
    role: string,
  ): Promise<TenantConfig> {
    if (role !== 'super_admin' && requesterTenantId !== tenantId) {
      throw new ForbiddenException('Cannot access another tenant config');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    return withLocationPresets(tenant.config as TenantConfig);
  }

  async updateConfig(
    tenantId: string,
    requesterTenantId: string | null,
    role: string,
    patch: UpdateTenantConfigRequest,
  ): Promise<TenantConfig> {
    if (!['admin', 'super_admin'].includes(role)) {
      throw new ForbiddenException('Admin access required');
    }
    if (role !== 'super_admin' && requesterTenantId !== tenantId) {
      throw new ForbiddenException('Cannot update another tenant config');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const current = tenant.config as TenantConfig;
    const next: TenantConfig = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.terminology !== undefined
        ? { terminology: { ...current.terminology, ...patch.terminology } }
        : {}),
      ...(patch.enabledModules !== undefined
        ? { enabledModules: patch.enabledModules }
        : {}),
      ...(patch.itemCategories !== undefined
        ? { itemCategories: patch.itemCategories }
        : {}),
      ...(patch.businessLocations !== undefined
        ? { businessLocations: patch.businessLocations }
        : {}),
      ...(patch.storageLocations !== undefined
        ? { storageLocations: patch.storageLocations }
        : {}),
      ...(patch.businessSettings !== undefined
        ? {
            businessSettings: mergeHq6BusinessSettings(
              current.businessSettings,
              patch.businessSettings,
            ),
          }
        : {}),
      ...(patch.hrmSettings !== undefined
        ? {
            hrmSettings: mergeHrmSettings(
              current.hrmSettings,
              patch.hrmSettings,
            ),
          }
        : {}),
    };

    // Zod-inferred nested objects are not assignable to Prisma.InputJsonValue.
    const configJson = next as unknown as Prisma.InputJsonValue;

    if (patch.name !== undefined) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { name: patch.name, config: configJson },
      });
    } else {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { config: configJson },
      });
    }

    return next;
  }
}

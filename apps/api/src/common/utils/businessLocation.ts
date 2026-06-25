import { BadRequestException } from '@nestjs/common';
import type { TenantConfig } from '@vonos/types';

export function businessLocationsFromConfig(config: unknown) {
  const typed = config as TenantConfig;
  return typed?.businessLocations ?? [];
}

/** When tenant has configured branches, require a valid location code. */
export function assertBusinessLocation(
  config: unknown,
  locationCode?: string | null,
): string | null {
  const locations = businessLocationsFromConfig(config);
  if (locations.length === 0) {
    return locationCode?.trim() || null;
  }

  const code = locationCode?.trim();
  if (!code) {
    throw new BadRequestException('Business location is required');
  }
  if (!locations.some((row) => row.code === code)) {
    throw new BadRequestException('Unknown business location');
  }
  return code;
}

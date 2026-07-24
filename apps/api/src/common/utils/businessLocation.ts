import { BadRequestException } from '@nestjs/common';
import type { TenantConfig } from '@vonos/types';

export function businessLocationsFromConfig(config: unknown) {
  const typed = config as TenantConfig;
  return typed?.businessLocations ?? [];
}

/**
 * Resolve a business location from a CSV code or display name.
 * Returns null when blank; throws when a value is given but unmatched.
 */
export function resolveBusinessLocationCode(
  config: unknown,
  locationNameOrCode?: string | null,
): string | null {
  const raw = locationNameOrCode?.trim();
  if (!raw) return null;

  const locations = businessLocationsFromConfig(config);
  if (locations.length === 0) return raw;

  const lower = raw.toLowerCase();
  const match = locations.find(
    (row) =>
      row.code.toLowerCase() === lower || row.name.toLowerCase() === lower,
  );
  if (!match) {
    throw new BadRequestException(`Unknown business location: ${raw}`);
  }
  return match.code;
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

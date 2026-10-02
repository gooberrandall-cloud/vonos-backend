export const ROLES = [
  "super_admin",
  "admin",
  "manager",
  "staff",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["invited", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ARCHETYPES = [
  "stock",
  "transaction",
  "job",
  "appointment",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

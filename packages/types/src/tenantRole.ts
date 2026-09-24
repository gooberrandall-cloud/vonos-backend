import type { Role } from "./role";

/** Per-tenant HQ6 / Ultimate POS job role (permission matrix). */
export interface TenantRole {
  id: string;
  tenantId: string;
  name: string;
  permissions: string[];
  isServiceStaff: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantRoleRequest {
  name: string;
  permissions?: string[];
  isServiceStaff?: boolean;
  locked?: boolean;
}

export interface UpdateTenantRoleRequest {
  name?: string;
  permissions?: string[];
  isServiceStaff?: boolean;
}

export interface ImportTenantRolesRequest {
  roles: Array<{
    name: string;
    permissions?: string[];
    isServiceStaff?: boolean;
    locked?: boolean;
  }>;
}

/**
 * Default permission set for HR roles on VAG / entity portals.
 * Onboard + manage staff (users / payroll / leave); no financial dashboard.
 * VAG can tick `app.finance.view` on the role if that HR user must see finance.
 */
export const HR_ROLE_DEFAULT_PERMISSIONS: readonly string[] = [
  "user.view",
  "user.create",
  "user.update",
  "roles.view",
  // HR can manage the shared VAG role matrix (create/update/delete role definitions).
  "roles.create",
  "roles.update",
  "roles.delete",
  "essentials.crud_leave_type",
  "essentials.crud_all_leave",
  "essentials.approve_leave",
  "essentials.crud_all_attendance",
  "essentials.view_allowance_and_deduction",
  "essentials.add_allowance_and_deduction",
  "essentials.crud_department",
  "essentials.crud_designation",
  "essentials.view_all_payroll",
  "essentials.create_payroll",
  "essentials.update_payroll",
  "essentials.delete_payroll",
];

/** True when the role name looks like an HR / people-ops role. */
export function isHrRoleName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n === "hr" ||
    n.startsWith("hr ") ||
    n.includes(" hr ") ||
    n.includes("human resource") ||
    n.includes("hr &") ||
    n.includes("hr&")
  );
}

/**
 * VAG portal access: group admin JWT, or any user assigned an HR TenantRole
 * (entity-scoped HR still lands on /admin and may edit the shared catalog).
 */
export function canAccessVagPortal(opts: {
  role: Role | null | undefined;
  tenantRoleName?: string | null;
}): boolean {
  if (opts.role === "super_admin") return true;
  if (opts.tenantRoleName && isHrRoleName(opts.tenantRoleName)) return true;
  return false;
}

/**
 * Permission keys that unlock Finance nav / P&L / payment accounts / costs.
 * Any one grants finance surface access (see HQ6_NAV_VIEW_PERMISSIONS.finance).
 */
export const FINANCE_ACCESS_PERMISSION_KEYS = [
  "app.finance.view",
  "account.access",
  "profit_loss_report.view",
] as const;

/** Keys seeded onto Accountant / Manager / Stock Keeper style roles. */
export const FINANCE_ROLE_DEFAULT_PERMISSIONS: readonly string[] = [
  "app.finance.view",
  "account.access",
  "profit_loss_report.view",
  "view_purchase_price",
  "view_product_stock_value",
  "expense_report.view",
  "purchase_n_sell_report.view",
  "all_expense.access",
];

/** True when `key` is a finance / accounts / cost visibility permission. */
export function isFinancePermissionKey(key: string): boolean {
  if (
    (FINANCE_ACCESS_PERMISSION_KEYS as readonly string[]).includes(key)
  ) {
    return true;
  }
  if (key === "view_purchase_price" || key === "view_product_stock_value") {
    return true;
  }
  if (key === "edit_account_transaction" || key === "delete_account_transaction") {
    return true;
  }
  if (
    key === "expense_report.view" ||
    key === "purchase_n_sell_report.view" ||
    key === "tax_report.view"
  ) {
    return true;
  }
  return false;
}

/**
 * Roles that receive financial dashboard access by default.
 * Only Accountant — managers / stock / HR must get it via the role checkbox
 * (`app.finance.view` / account / P&L keys) when VAG grants it.
 */
export function isFinanceAuthorizedRoleName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n || n === "admin") return false;
  // Never auto-grant via "manager" inside "HR & OPERATIONS MANAGER".
  if (isHrRoleName(name)) return false;
  return n === "accountant" || n.includes("accountant");
}

/** Default demo role names seeded when a tenant has no roles yet. */
export const TENANT_ROLE_DEMO_NAMES = [
  "AC TECHNICIAN",
  "ACCOUNTANT",
  "Admin",
  "Assistant Manager",
  "AUTO-ELECTRICIAN",
  "AUTO-MECHANIC",
  "AUTO-REPAIR QC OFFICER",
  "BODY WORKS AND PAINTING",
  "CAR WASH ATTENDANT",
  "CLEANER",
  "Domestic Driver",
  "FRONT DESK",
  "HEAD OF TRAINIING",
  "HR & OPERATIONS MANAGER",
  "INTERN",
  "MACHINIST",
  "MANAGER",
  "Manager1",
  "NYSC INTERN",
  "OFFICE ASSISTANT",
  "PARTS AUDITOR",
  "PARTS MANAGEMENT",
  "QUALITY CONTROL OFFICER",
  "SALES REPRESENTATIVE/MARKETERS",
  "SECURITY/CLEANING",
  "Service Staff",
  "SOCIAL MEDIA MANAGER",
  "Stock Keeper",
  "TECHNICAL SUPERVISOR",
  "WEB DEVELOPER",
] as const;

export function isFullAccessTenantRole(role: {
  locked: boolean;
  name: string;
}): boolean {
  if (role.locked) return true;
  return role.name.trim().toLowerCase() === "admin";
}

/**
 * Maps a tenant job role onto the JWT Role enum required by the API.
 */
export function mapTenantRoleToJwtRole(role: {
  locked: boolean;
  name: string;
  permissions: string[];
}): Exclude<Role, "super_admin"> {
  if (isFullAccessTenantRole(role)) return "admin";

  const perms = new Set(role.permissions);
  const name = role.name.trim().toLowerCase();

  if (
    perms.has("user.create") ||
    perms.has("user.delete") ||
    perms.has("roles.create") ||
    perms.has("roles.delete") ||
    perms.has("business_settings.access")
  ) {
    return "admin";
  }

  if (
    perms.has("essentials.approve_leave") ||
    perms.has("purchase.update_status") ||
    perms.has("user.update") ||
    name.includes("manager") ||
    name.includes("supervisor") ||
    name.includes("head of")
  ) {
    return "manager";
  }

  if (
    name.includes("intern") ||
    name.includes("cleaner") ||
    name.includes("security") ||
    name.includes("viewer") ||
    name === "nysc intern"
  ) {
    return "viewer";
  }

  return "staff";
}

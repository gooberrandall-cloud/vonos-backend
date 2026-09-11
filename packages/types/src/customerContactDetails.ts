/**
 * Ultimate POS / HQ6 contact form extras stored on Customer.details.
 * Custom field labels match the live POS contact form (automotive-oriented).
 */
export const CONTACT_CUSTOM_FIELD_LABELS = [
  "Milage",
  "VIN Number",
  "Car Model & Year",
  "Customer Location",
  "Referral source",
  "Custom Field 6",
  "Custom Field 7",
  "Custom Field 8",
  "Custom Field 9",
  "Custom Field 10",
] as const;

export type ContactCustomFieldKey =
  | "customField1"
  | "customField2"
  | "customField3"
  | "customField4"
  | "customField5"
  | "customField6"
  | "customField7"
  | "customField8"
  | "customField9"
  | "customField10";

export type ContactPayTermType = "days" | "months";

export interface CustomerContactDetails {
  contactKind?: "individual" | "business";
  /** User-visible Contact ID (empty = autogenerate). */
  contactId?: string | null;
  businessName?: string | null;
  prefix?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  alternateNumber?: string | null;
  landline?: string | null;
  payTermNumber?: number | null;
  payTermType?: ContactPayTermType | null;
  creditLimit?: number | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zipCode?: string | null;
  landmark?: string | null;
  streetName?: string | null;
  buildingNumber?: string | null;
  additionalNumber?: string | null;
  shippingAddress?: string | null;
  customField1?: string | null;
  customField2?: string | null;
  customField3?: string | null;
  customField4?: string | null;
  customField5?: string | null;
  customField6?: string | null;
  customField7?: string | null;
  customField8?: string | null;
  customField9?: string | null;
  customField10?: string | null;
  /** HRM employee (worker) responsible for this contact — see Employee.id. */
  assignedToEmployeeId?: string | null;
  /** Cached employee name for display (resolved at write time). */
  assignedToEmployeeName?: string | null;
}

export const CONTACT_CUSTOM_FIELD_KEYS: ContactCustomFieldKey[] = [
  "customField1",
  "customField2",
  "customField3",
  "customField4",
  "customField5",
  "customField6",
  "customField7",
  "customField8",
  "customField9",
  "customField10",
];

export function emptyCustomerContactDetails(): CustomerContactDetails {
  return {
    contactKind: "individual",
    contactId: null,
    businessName: null,
    prefix: null,
    firstName: null,
    middleName: null,
    lastName: null,
    alternateNumber: null,
    landline: null,
    payTermNumber: null,
    payTermType: null,
    creditLimit: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    country: null,
    zipCode: null,
    landmark: null,
    streetName: null,
    buildingNumber: null,
    additionalNumber: null,
    shippingAddress: null,
    customField1: null,
    customField2: null,
    customField3: null,
    customField4: null,
    customField5: null,
    customField6: null,
    customField7: null,
    customField8: null,
    customField9: null,
    customField10: null,
    assignedToEmployeeId: null,
    assignedToEmployeeName: null,
  };
}

export function parseCustomerContactDetails(
  raw: unknown,
): CustomerContactDetails {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyCustomerContactDetails();
  }
  const o = raw as Record<string, unknown>;
  /** Coerce string or finite number (legacy UPOS year fields) to trimmed text. */
  const str = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  };
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const kind =
    o.contactKind === "business" || o.contactKind === "individual"
      ? o.contactKind
      : "individual";
  const payTermType =
    o.payTermType === "days" || o.payTermType === "months"
      ? o.payTermType
      : null;

  return {
    contactKind: kind,
    contactId: str(o.contactId),
    businessName: str(o.businessName),
    prefix: str(o.prefix),
    firstName: str(o.firstName),
    middleName: str(o.middleName),
    lastName: str(o.lastName),
    alternateNumber: str(o.alternateNumber),
    landline: str(o.landline),
    payTermNumber: num(o.payTermNumber),
    payTermType,
    creditLimit: num(o.creditLimit),
    addressLine1: str(o.addressLine1),
    addressLine2: str(o.addressLine2),
    city: str(o.city),
    state: str(o.state),
    country: str(o.country),
    zipCode: str(o.zipCode),
    landmark: str(o.landmark),
    streetName: str(o.streetName),
    buildingNumber: str(o.buildingNumber),
    additionalNumber: str(o.additionalNumber),
    shippingAddress: str(o.shippingAddress),
    customField1: str(o.customField1),
    customField2: str(o.customField2),
    customField3: str(o.customField3),
    customField4: str(o.customField4),
    customField5: str(o.customField5),
    customField6: str(o.customField6),
    customField7: str(o.customField7),
    customField8: str(o.customField8),
    customField9: str(o.customField9),
    customField10: str(o.customField10),
    assignedToEmployeeId: str(o.assignedToEmployeeId),
    assignedToEmployeeName: str(o.assignedToEmployeeName),
  };
}

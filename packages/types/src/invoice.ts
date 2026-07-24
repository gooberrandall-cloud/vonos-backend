export interface InvoiceLayout {
  id: string;
  tenantId: string;
  name: string;
  design: "classic" | "slim" | "detailed" | string;
  headerText: string | null;
  footerText: string | null;
  termsText: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceScheme {
  id: string;
  tenantId: string;
  name: string;
  prefix: string | null;
  startNumber: number;
  invoiceCount: number;
  totalDigits: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptPrinter {
  id: string;
  tenantId: string;
  name: string;
  printerType: "browser" | "network" | string;
  connectionString: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceSettings {
  layouts: InvoiceLayout[];
  schemes: InvoiceScheme[];
  printers: ReceiptPrinter[];
  defaultLayoutId: string | null;
  defaultSchemeId: string | null;
  termsText: string | null;
}

export interface UpdateInvoiceSettingsInput {
  defaultLayoutId?: string | null;
  defaultSchemeId?: string | null;
  termsText?: string | null;
}

export interface CreateInvoiceSchemeInput {
  name: string;
  prefix?: string | null;
  startNumber?: number;
  totalDigits?: number;
  isDefault?: boolean;
}

export interface UpdateInvoiceSchemeInput {
  name?: string;
  prefix?: string | null;
  startNumber?: number;
  totalDigits?: number;
  isDefault?: boolean;
}

export type InvoiceLayoutDesign = "classic" | "slim" | "detailed" | "elegant";

export interface CreateInvoiceLayoutInput {
  name: string;
  design?: InvoiceLayoutDesign | string;
  headerText?: string | null;
  footerText?: string | null;
  termsText?: string | null;
  isDefault?: boolean;
}

export interface UpdateInvoiceLayoutInput {
  name?: string;
  design?: InvoiceLayoutDesign | string;
  headerText?: string | null;
  footerText?: string | null;
  termsText?: string | null;
  isDefault?: boolean;
}

export interface CreateReceiptPrinterInput {
  name: string;
  printerType?: string;
  connectionString?: string | null;
  isDefault?: boolean;
}

export interface UpdateReceiptPrinterInput {
  name?: string;
  printerType?: string;
  connectionString?: string | null;
  isDefault?: boolean;
}

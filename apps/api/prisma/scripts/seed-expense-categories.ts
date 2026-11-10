/**
 * Seed Ultimate POS / former HQ expense categories into Vonos tenants.
 * Source: legacy `expense_categories` (operational catalog from HQ dumps).
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/seed-expense-categories.ts
 *   TENANT_CODE=VA npx ts-node --transpile-only prisma/scripts/seed-expense-categories.ts
 *   TENANT_CODES=VA,VW,VISP,VSP,VP npx ts-node --transpile-only prisma/scripts/seed-expense-categories.ts
 *   npx ts-node --transpile-only prisma/scripts/seed-expense-categories.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const onlyCode = (process.env.TENANT_CODE ?? '').trim().toUpperCase();
const tenantCodes = (process.env.TENANT_CODES ?? '')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

const OPERATING = new Set([
  'VA',
  'VW',
  'VISP',
  'VSP',
  'VP',
  'VC',
  'VS',
  'VKW',
]);

const TARGET_CODES =
  tenantCodes.length > 0
    ? new Set(tenantCodes)
    : onlyCode
      ? new Set([onlyCode])
      : OPERATING;

/** Former HQ / Ultimate POS expense categories (operational catalog).
 * Includes restored soft-deleted HQ rows + group operational names;
 * excludes one-off 2024 budget-bucket labels.
 */
const EXPENSE_CATEGORIES: ReadonlyArray<{ name: string; code: string | null }> = [
  { name: 'ABUJA CONSUMABLE PARTS', code: 'ASP' },
  { name: 'ABUJA GOODS/PARTS', code: null },
  { name: 'ABUJA LOGISTICS FOR INTL', code: 'AL' },
  { name: 'AC GAS SUPPLIED', code: 'AGS' },
  { name: 'AC WORKMANSHIP', code: null },
  { name: 'ACCOMMODATION LOAN', code: null },
  { name: 'AIRTIME', code: 'AT' },
  { name: 'AIRTIME AND DATA', code: null },
  { name: 'ALIGNMENT CONSUMABLE', code: null },
  { name: 'BATTERY.', code: 'B' },
  { name: 'Bike fair transport', code: null },
  { name: 'BIKE REPAIRS', code: 'BR' },
  { name: 'BOSS EXPENSE', code: 'B/E' },
  { name: 'BOSS EXPENSES', code: null },
  { name: 'BUMPER REPAIRS', code: 'BR' },
  { name: 'BWARI AREA COUNCIL LEVY', code: 'BACL' },
  { name: 'CAR CLEARING PAYMENT', code: 'CCP' },
  { name: 'CAR WASH', code: null },
  { name: 'CARBAD', code: 'C' },
  { name: 'CASH BACK', code: 'CB' },
  { name: 'CASH SUMMITTED TO BOSS', code: 'CSTB' },
  { name: 'CEMEMT', code: 'C' },
  { name: 'CHINA GOODS', code: null },
  { name: 'CHINA GOODS TRANSPORT', code: null },
  { name: 'CLEARING OF CAR', code: null },
  { name: 'COMPANY ACCOUNT', code: null },
  { name: 'COMPANY AUDIT', code: 'CA' },
  { name: 'COMPANY BIKE EXPENSES', code: 'CBE' },
  { name: 'COMPANY BIKE REPAIRS', code: 'CBR' },
  { name: 'CUSTOMER WATER', code: null },
  { name: 'CUSTOMER WELFARE/WATER/DRINKS', code: 'C/W' },
  { name: 'DESIEL', code: 'D' },
  { name: 'DETERGENT/LIQUID SOAP/RAZOR BLADE', code: 'D/L' },
  { name: 'DETERGENT/WASHES', code: null },
  { name: 'DEVELOPMENT CONTROL', code: null },
  { name: 'DIESEL', code: null },
  { name: 'DIRECT', code: 'DR' },
  { name: 'DISPOSAL OF WASTE BIN', code: 'DWB' },
  { name: 'ELECTRICAL CONSUMABLES', code: 'EWO' },
  { name: 'ELECTRICAL MATERIALS', code: null },
  { name: 'ELECTRICITY', code: 'EE' },
  { name: 'Electricity bill', code: null },
  { name: 'ELECTRICITY PENALTY', code: null },
  { name: 'ELECTRONICS/LIGHTENING', code: 'E/L' },
  { name: 'ENGINE OIL', code: 'EO' },
  { name: 'ENUGU/ONITSHA LOGISTIC', code: 'E/O/L' },
  { name: 'EQUIPMENT MAINTENANCE', code: 'EM' },
  { name: 'EQUIPMENTS AND TOOLS', code: null },
  { name: 'FUEL', code: 'F' },
  { name: 'GENERATOR MAINTENACE', code: 'GM' },
  { name: 'GRINDING OF TOP/RESURAFCING', code: 'G/R' },
  { name: 'GWARIMPA BRANCH', code: 'G\B' },
  { name: 'Gwarimpa expenses 2024', code: null },
  { name: 'House rents', code: null },
  { name: 'I.O.U', code: null },
  { name: 'I.O.U AND SALARY', code: null },
  { name: 'INDIRECT', code: 'IDR' },
  { name: 'INTEREST ON LOAN', code: null },
  { name: 'INTERNETS', code: null },
  { name: 'INTL SHOP GOODS', code: null },
  { name: 'INTL SPARE PARTS LOGISTICS', code: 'ISPC' },
  { name: 'INTL SPARE PARTS PURCHASE', code: 'ISPP' },
  { name: 'IOU', code: 'IOU' },
  { name: 'KEY CUTTING/PROGRAMMING.', code: 'KCP' },
  { name: 'LAGOS CONSUMABLE PARTS', code: null },
  { name: 'LAGOS CONSUMABLE TRANSPORT', code: null },
  { name: 'LAGOS GOODS', code: null },
  { name: 'LAGOS SPARE PARTS', code: 'LSP' },
  { name: 'LAGOS SPARE PARTS LOGISTICS', code: 'LSPL' },
  { name: 'LOAN', code: 'LO' },
  { name: 'LOCAL GOODS FOR SHOP', code: null },
  { name: 'MANAGER WATER/DRINKS', code: 'MWD' },
  { name: 'MECHANICAL CONSUMABLE', code: null },
  { name: 'MEDIA TOOLS', code: 'MT' },
  { name: 'MEDICALS', code: null },
  { name: 'MISCELLANEOUS', code: null },
  { name: 'MONIE POINT LOAN', code: null },
  { name: 'NEW EQUIPMENT/TOOLS', code: 'NET' },
  { name: 'NEW PLAZA', code: null },
  { name: 'OTHERS TRANSPORT', code: 'OT' },
  { name: 'OUTSIDE MECHANIC PAYMENT', code: 'OMP' },
  { name: 'OUTSIDE OIL SUPPLIED', code: null },
  { name: 'OUTSIDE SUB-CONTRACTOR', code: 'OSC' },
  { name: 'OVEN MAINTENANCE', code: 'O/M' },
  { name: 'PADLOCK,LADDER/REPAIRS', code: 'PLR' },
  { name: 'PAINT/PANEL', code: 'P/P' },
  { name: 'PAINT/PANEL MATERIALS OT', code: 'P\P\M' },
  { name: 'PAINTING MATERIALS', code: 'P/M' },
  { name: 'PANEL BEATER GAS', code: 'PBG' },
  { name: 'PANEL BEATER MATERIAL FOR WORK', code: 'P/B/M/W' },
  { name: 'PARTS FROM VONOS STORE', code: 'PFVS' },
  { name: 'PENSION FUND', code: null },
  { name: 'PLAZA INTERNET', code: 'P/I' },
  { name: 'PLAZA MAINTENANCE', code: 'PM' },
  { name: 'PLUMBING WORK/MATERIAL.', code: 'P/W/M.' },
  { name: 'PRINTER REPAIRS/ TONER REFILLING', code: 'PRTR' },
  { name: 'RADIATOR REPAIRS', code: 'R/R' },
  { name: 'REFUND', code: null },
  { name: 'REFUND TO CUSTOMERS', code: 'RTC' },
  { name: 'REMITTANCES', code: null },
  { name: 'REPAIRS OF MACHINES/EQUIPMENT MAINTENANCE', code: 'EM' },
  { name: 'REPAIRS PARTS', code: 'RP' },
  { name: 'REPAIRS/MAINTENACE OF EQUIPMENT AND TOOLS', code: null },
  { name: 'SAFETY BOOTH/ OVERHAUL./T.SHIRT', code: 'SBOTS' },
  { name: 'SALARY', code: 'SL' },
  { name: 'SANDRA WATER/DRINKS', code: null },
  { name: 'SECURITY SUPPLY', code: 'SS' },
  { name: 'SOCIAL MEDIA', code: null },
  { name: 'STAFF AWARDS', code: null },
  { name: 'STAFF HOUSE RENT', code: null },
  { name: 'STAFF HOUSE RENT ALLOWANCE', code: null },
  { name: 'STAFF INJURY/TREATMENT', code: 'SIT' },
  { name: 'STAFF LOAN', code: 'SL' },
  { name: 'STAFF MEDICAL TREATMENT', code: 'SMT' },
  { name: 'STAFF PENSION REMITTANCE', code: 'SPR' },
  { name: 'STAFF WELFARE.', code: 'S/F' },
  { name: 'STATIONARY MATERIALS', code: 'S/M' },
  { name: 'SUBCONTRACTOR WORKMANSHIP', code: null },
  { name: 'SYSTEM SOFTWARE INSTALLATION', code: 'SSI' },
  { name: 'TAX', code: null },
  { name: 'TAXES/STAMP DUTY PAYMENT', code: 'TSDP' },
  { name: 'TINT OF GLASS', code: 'TOG' },
  { name: 'TIRES', code: 'Ty' },
  { name: 'TOOLS AND EQUIPMENT', code: null },
  { name: 'TOWING OF CARS', code: 'TOC' },
  { name: 'TRANSMISSION WORK', code: 'T/W' },
  { name: 'TRANSPORT/BIKE FAIR', code: null },
  { name: 'TRANSPORTATIONS', code: null },
  { name: 'TYRES PUCHASE', code: 'T/P' },
  { name: 'UPHOLSTERY WORK', code: 'UW' },
  { name: 'V.I.O/ROAD SAFETY', code: 'VRS' },
  { name: 'VONOS SHOP - CRYSTAL GREASE', code: null },
  { name: 'VONOS TIRES', code: 'VT' },
  { name: 'WAITING AREA ITEMS', code: 'WAI' },
  { name: 'WASTE DISPOSAL', code: null },
  { name: 'WEBSITE', code: null },
  { name: 'WEBSITE PAYMENT', code: 'WSP' },
  { name: 'WELDING WORK OUTSIDE.', code: 'WWO' },
  { name: 'WINDSHIELD GLASS/FIXING', code: 'WGF' },
  { name: 'WORKSHOP FUEL USAGE', code: 'WFU' },
];


async function seedTenant(tenantId: string, code: string) {
  let created = 0;
  let existed = 0;
  let updated = 0;

  for (const cat of EXPENSE_CATEGORIES) {
    const existing = await prisma.expenseCategory.findFirst({
      where: {
        tenantId,
        deletedAt: null,
        name: { equals: cat.name, mode: 'insensitive' },
      },
      select: { id: true, code: true },
    });

    if (existing) {
      existed += 1;
      if (cat.code && existing.code !== cat.code) {
        if (!dryRun) {
          await prisma.expenseCategory.update({
            where: { id: existing.id },
            data: { code: cat.code },
          });
        }
        updated += 1;
      }
      continue;
    }

    if (!dryRun) {
      await prisma.expenseCategory.create({
        data: {
          tenantId,
          name: cat.name,
          code: cat.code,
        },
      });
    }
    created += 1;
  }

  console.log(
    `${code}: created=${created}, already_present=${existed}, codes_updated=${updated}`,
  );
}

async function main() {
  const tenants = (
    await prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    })
  ).filter((t) => TARGET_CODES.has(t.code.toUpperCase()));

  if (tenants.length === 0) {
    throw new Error(
      tenantCodes.length > 0
        ? `No tenants found for TENANT_CODES=${tenantCodes.join(',')}`
        : onlyCode
          ? `Tenant ${onlyCode} not found`
          : 'No operating tenants found to seed',
    );
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        categoryCount: EXPENSE_CATEGORIES.length,
        tenants: tenants.map((t) => t.code),
      },
      null,
      2,
    ),
  );

  for (const tenant of tenants) {
    await seedTenant(tenant.id, tenant.code);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

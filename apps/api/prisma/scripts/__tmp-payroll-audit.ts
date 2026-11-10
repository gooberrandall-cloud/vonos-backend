import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();

async function main() {
  // 1. Rows where stored netPay disagrees with gross + allowance - deduction.
  const mismatch: any[] = await p.$queryRawUnsafe(`
    SELECT id, "employeeName", "grossPay"::float AS gross, "totalAllowance"::float AS allow,
           "totalDeduction"::float AS ded, "netPay"::float AS net,
           ("grossPay" + "totalAllowance" - "totalDeduction")::float AS expected,
           note
    FROM "Payroll"
    WHERE "deletedAt" IS NULL
      AND ABS("netPay" - ("grossPay" + "totalAllowance" - "totalDeduction")) > 0.01
    LIMIT 30
  `);
  console.log(`netPay mismatches: ${mismatch.length}`);
  console.table(
    mismatch.map((r) => ({
      emp: r.employeeName,
      gross: r.gross,
      allow: r.allow,
      ded: r.ded,
      net: r.net,
      expected: r.expected,
      note: (r.note || '').slice(0, 60),
    })),
  );

  // 2. Double-count candidates: note says "Basic: X ... " and grossPay ~= basic + allowance.
  const withAllow: any[] = await p.$queryRawUnsafe(`
    SELECT id, "employeeName", "grossPay"::float AS gross, "totalAllowance"::float AS allow,
           "totalDeduction"::float AS ded, "netPay"::float AS net, note
    FROM "Payroll"
    WHERE "deletedAt" IS NULL AND "totalAllowance" > 0
    LIMIT 5000
  `);
  const basicRe = /Basic:\s*([0-9,.]+)/i;
  const suspects = withAllow
    .map((r) => {
      const m = (r.note || '').match(basicRe);
      if (!m) return null;
      const basic = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(basic) || basic <= 0) return null;
      const doubleCounted = Math.abs(r.gross - (basic + r.allow)) < 0.01;
      const basicEqualsGross = Math.abs(r.gross - basic) < 0.01;
      return doubleCounted && !basicEqualsGross
        ? { emp: r.employeeName, gross: r.gross, basic, allow: r.allow, net: r.net }
        : null;
    })
    .filter(Boolean);
  console.log(`rows with allowance + parsable Basic: ${withAllow.length}, double-count suspects: ${suspects.length}`);
  console.table(suspects.slice(0, 30));

  // 3. Payments on payroll invoices vs row paymentStatus.
  const paidButUnpaid: any[] = await p.$queryRawUnsafe(`
    SELECT pr.id, pr."employeeName", pr."paymentStatus" AS row_status, pr."netPay"::float AS net,
           COALESCE(SUM(pay.amount), 0)::float AS paid_sum, i.kind, i.reference
    FROM "Payroll" pr
    JOIN "Invoice" i ON i."payrollId" = pr.id
    JOIN "Payment" pay ON pay."invoiceId" = i.id
    WHERE pr."deletedAt" IS NULL
    GROUP BY pr.id, pr."employeeName", pr."paymentStatus", pr."netPay", i.kind, i.reference
    HAVING pr."paymentStatus" <> 'paid' OR COALESCE(SUM(pay.amount),0) < pr."netPay" - 0.01
    LIMIT 30
  `);
  console.log(`payroll rows with payments but not fully paid: ${paidButUnpaid.length}`);
  console.table(
    paidButUnpaid.map((r) => ({
      emp: r.employeeName,
      status: r.row_status,
      net: r.net,
      paid: r.paid_sum,
      ref: r.reference,
    })),
  );

  // 4. Group invoices payment status vs actual row settlement.
  const groupInv: any[] = await p.$queryRawUnsafe(`
    SELECT i.reference, i."paymentStatus" AS inv_status, g.name,
      COUNT(pr.id)::int AS rows,
      COUNT(pr.id) FILTER (WHERE pr."paymentStatus" = 'paid')::int AS paid_rows,
      COUNT(pr.id) FILTER (WHERE pr."paymentStatus" <> 'paid' AND pr."netPay" > 0)::int AS unpaid_positive
    FROM "Invoice" i
    JOIN "PayrollGroup" g ON g.id = i."payrollGroupId"
    LEFT JOIN "Payroll" pr ON pr."payrollGroupId" = g.id AND pr."deletedAt" IS NULL
    WHERE i.kind = 'payroll_group' AND g."deletedAt" IS NULL
    GROUP BY i.reference, i."paymentStatus", g.name
    HAVING i."paymentStatus" <> 'paid'
    ORDER BY unpaid_positive ASC
    LIMIT 30
  `);
  console.log(`group invoices not 'paid': ${groupInv.length}`);
  console.table(
    groupInv.map((r) => ({
      ref: r.reference,
      inv: r.inv_status,
      group: r.name,
      rows: r.rows,
      paid: r.paid_rows,
      unpaid: r.unpaid_positive,
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());

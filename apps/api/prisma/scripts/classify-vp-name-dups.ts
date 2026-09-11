/**
 * Classify VP name-duplicate groups: safe merge vs keep separate.
 * Usage: npx tsx prisma/scripts/classify-vp-name-dups.ts
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

function loadDotEnv(path: string): void {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}

loadDotEnv(resolve(__dirname, '../../.env'));
const prisma = new PrismaClient();

function isNameAsSku(name: string, sku: string) {
  return sku.trim().toLowerCase() === name.trim().toLowerCase();
}
function isVonosAuto(sku: string) {
  return /^vonos\s*auto[-_\s]?\d+/i.test(sku.trim());
}

async function main() {
  const vp = await prisma.tenant.findFirst({
    where: { code: 'VP', deletedAt: null },
  });
  if (!vp) throw new Error('VP missing');

  const rows = await prisma.item.findMany({
    where: { tenantId: vp.id, deletedAt: null },
    select: { id: true, name: true, sku: true, quantity: true },
  });

  const map = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.name.trim().toLowerCase();
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(r);
    map.set(k, list);
  }

  let groups = 0;
  let extras = 0;
  let exactSkuNameOnly = 0;
  let nameAsSkuPlusVonos = 0;
  let vonosOnly = 0;
  let distinctRealSkus = 0;
  const samples: string[] = [];

  for (const [name, list] of map) {
    if (list.length < 2) continue;
    groups += 1;
    extras += list.length - 1;
    const nameSku = list.filter((r) => isNameAsSku(r.name, r.sku));
    const vonos = list.filter((r) => isVonosAuto(r.sku));
    const other = list.filter(
      (r) => !isNameAsSku(r.name, r.sku) && !isVonosAuto(r.sku),
    );

    let kind = 'mixed';
    if (other.length === 0 && nameSku.length >= 2 && vonos.length === 0) {
      kind = 'exact-name-as-sku';
      exactSkuNameOnly += 1;
    } else if (other.length === 0 && nameSku.length >= 1 && vonos.length >= 1) {
      kind = 'name-as-sku+vonos';
      nameAsSkuPlusVonos += 1;
    } else if (other.length === 0 && vonos.length === list.length) {
      kind = 'vonos-only';
      vonosOnly += 1;
    } else if (other.length >= 2 || (other.length >= 1 && list.length >= 2)) {
      kind = 'distinct-real-skus';
      distinctRealSkus += 1;
    }

    if (samples.length < 25) {
      samples.push(
        `${kind} ×${list.length} "${name}" → ${list
          .map((r) => r.sku)
          .slice(0, 4)
          .join(' | ')}`,
      );
    }
  }

  console.log({
    groups,
    extras,
    exactSkuNameOnly,
    nameAsSkuPlusVonos,
    vonosOnly,
    distinctRealSkus,
    samples,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

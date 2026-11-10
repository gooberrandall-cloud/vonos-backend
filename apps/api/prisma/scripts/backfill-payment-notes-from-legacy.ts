/**
 * Backfill Payment.note from legacy Ultimate POS transaction_payments.note.
 *
 * Migration often left notes empty even when the dump had them.
 *
 * Usage (from apps/api):
 *   npx ts-node --transpile-only prisma/scripts/backfill-payment-notes-from-legacy.ts
 *   DRY_RUN=1 ...
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const legacySql =
  process.env.LEGACY_SQL?.trim() ||
  path.resolve(process.cwd(), '../../localhost.sql');

type Source = {
  db: string;
  tenantCode: string;
  offset: number;
};

const SOURCES: Source[] = [
  { db: 'vonomglk_hq3temp', tenantCode: 'VA', offset: 20_000_000 },
  { db: 'vonomglk_hq2', tenantCode: 'VA', offset: 30_000_000 },
  { db: 'vonomglk_cafe', tenantCode: 'VC', offset: 0 },
  { db: 'vonomglk_vsp', tenantCode: 'VISP', offset: 0 },
  { db: 'vonomglk_spmarket', tenantCode: 'VSP', offset: 0 },
];

function unescapeSql(value: string): string {
  return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function parseTupleFields(tuple: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i]!;
    if (inStr) {
      if (ch === '\\' && i + 1 < tuple.length) {
        cur += ch + tuple[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inStr = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === ',') {
      fields.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function parseCreateColumns(lines: string[]): string[] {
  const cols: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*`([^`]+)`/);
    if (m) cols.push(m[1]!);
  }
  return cols;
}

async function scanDb(dbName: string): Promise<Map<number, string>> {
  const notes = new Map<number, string>();
  const rl = createInterface({
    input: createReadStream(legacySql, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let inDb = false;
  let mode: 'none' | 'create' | 'insert' = 'none';
  let createBuf: string[] = [];
  let cols: string[] | null = null;

  for await (const line of rl) {
    if (line.startsWith('USE `')) {
      const m = line.match(/^USE `([^`]+)`/);
      inDb = m?.[1] === dbName;
      mode = 'none';
      continue;
    }
    if (!inDb) continue;

    if (line.startsWith('CREATE TABLE `transaction_payments`')) {
      mode = 'create';
      createBuf = [];
      continue;
    }
    if (mode === 'create') {
      createBuf.push(line);
      if (line.startsWith(')')) {
        cols = parseCreateColumns(createBuf);
        mode = 'none';
        createBuf = [];
      }
      continue;
    }

    if (line.startsWith('INSERT INTO `transaction_payments`')) {
      mode = 'insert';
      continue;
    }
    if (line.startsWith('INSERT INTO `')) {
      mode = 'none';
      continue;
    }
    if (mode !== 'insert' || !line.startsWith('(')) continue;

    const trimmed = line.trim().replace(/,$/, '').replace(/;$/, '');
    if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) continue;
    const fields = parseTupleFields(trimmed.slice(1, -1));
    const idIdx = cols?.indexOf('id') ?? 0;
    const noteIdx = cols?.indexOf('note') ?? -1;
    if (noteIdx < 0 || fields.length <= Math.max(idIdx, noteIdx)) continue;
    const id = Number(fields[idIdx]);
    let noteRaw = fields[noteIdx] ?? 'NULL';
    if (!Number.isFinite(id) || noteRaw === 'NULL') continue;
    noteRaw = unescapeSql(noteRaw.replace(/^'|'$/g, '')).trim();
    if (!noteRaw) continue;
    notes.set(id, noteRaw);
  }

  return notes;
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN' : 'WRITE');
  console.log(`SQL: ${legacySql}`);

  const tenants = await prisma.tenant.findMany({
    where: { code: { in: [...new Set(SOURCES.map((s) => s.tenantCode))] } },
    select: { id: true, code: true },
  });
  const tenantByCode = new Map(tenants.map((t) => [t.code, t.id]));

  let updated = 0;
  let skippedHasNote = 0;
  let missingMap = 0;

  for (const source of SOURCES) {
    const tenantId = tenantByCode.get(source.tenantCode);
    if (!tenantId) {
      console.warn(`Skip ${source.db}: tenant ${source.tenantCode} not found`);
      continue;
    }

    console.log(
      `\nScanning ${source.db} → ${source.tenantCode} (offset +${source.offset})…`,
    );
    const notesByLegacy = await scanDb(source.db);
    console.log(`  payments with note in dump: ${notesByLegacy.size}`);

    const maps = await prisma.migrationLegacyId.findMany({
      where: {
        tenantId,
        entityType: 'payment',
      },
      select: { legacyId: true, newId: true },
    });

    const patches: Array<{ id: string; note: string }> = [];
    for (const m of maps) {
      if (source.offset > 0) {
        if (
          m.legacyId < source.offset ||
          m.legacyId >= source.offset + 10_000_000
        ) {
          continue;
        }
      } else if (m.legacyId >= 10_000_000) {
        continue;
      }
      const raw = m.legacyId - source.offset;
      const note = notesByLegacy.get(raw);
      if (!note) {
        missingMap += 1;
        continue;
      }
      patches.push({ id: m.newId, note });
    }

    const existing = await prisma.payment.findMany({
      where: {
        id: { in: patches.map((p) => p.id) },
        deletedAt: null,
      },
      select: { id: true, note: true },
    });
    const byId = new Map(existing.map((e) => [e.id, e]));

    const toWrite: Array<{ id: string; note: string }> = [];
    for (const p of patches) {
      const row = byId.get(p.id);
      if (!row) continue;
      if (row.note?.trim()) {
        skippedHasNote += 1;
        continue;
      }
      toWrite.push(p);
    }

    console.log(`  patches to write: ${toWrite.length}`);
    if (!DRY_RUN) {
      const BATCH = 100;
      for (let i = 0; i < toWrite.length; i += BATCH) {
        const chunk = toWrite.slice(i, i + BATCH);
        await prisma.$transaction(
          chunk.map((row) =>
            prisma.payment.update({
              where: { id: row.id },
              data: { note: row.note },
            }),
          ),
        );
      }
    }
    updated += toWrite.length;
  }

  console.log('\nDone', { updated, skippedHasNote, missingMap, DRY_RUN });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

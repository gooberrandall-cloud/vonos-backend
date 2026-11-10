#!/usr/bin/env node
/**
 * Optimize apps/web/public/images and mirror it to the Cloudflare R2 bucket that
 * serves NEXT_PUBLIC_CDN_URL (zero egress, keeps image bytes off Vercel).
 *
 *   npm run cdn:sync                       # sync everything under public/images
 *   npm run cdn:sync -- --only vonos-photos
 *   npm run cdn:sync -- --dry-run
 *   npm run cdn:sync -- --force            # re-upload even when unchanged
 *   npm run cdn:sync -- --prune            # delete remote keys with no local file
 *
 * Object keys mirror the public path under a "static/" prefix, so
 *   NEXT_PUBLIC_CDN_URL=https://pub-<hash>.r2.dev/static
 * resolves /images/vonos-photos/IMG_0437.jpg to
 *   https://pub-<hash>.r2.dev/static/images/vonos-photos/IMG_0437.jpg
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const PUBLIC_DIR = path.join(REPO, "apps/web/public");
const SOURCES = ["images", "brand"];
const PREFIX = "static/";
const MAX_EDGE = 1600;
const QUALITY = 82;
/** Responsive width variants for large JPEGs: target width → encode quality. */
const VARIANTS = [
  { suffix: "-w500", width: 500, quality: 70 },
  { suffix: "-w800", width: 800, quality: 75 },
  { suffix: "-w1200", width: 1200, quality: 80 },
];
const CONCURRENCY = 6;
const CACHE_CONTROL = "public, max-age=31536000, immutable";

const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const dryRun = flag("--dry-run");
const force = flag("--force");
const prune = flag("--prune");
const only = option("--only");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} (set it in apps/api/.env)`);
    process.exit(1);
  }
  return value;
}

const accountId = requireEnv("R2_ACCOUNT_ID");
const bucket = requireEnv("R2_BUCKET");
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  },
});

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && entry.name !== ".DS_Store") out.push(full);
  }
  return out;
}

/** Resize to <=1600px on the longest edge, then re-encode. Never returns a bigger buffer. */
async function optimize(buffer, ext) {
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return buffer;
  try {
    const image = sharp(buffer, { failOn: "none" }).rotate();
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return buffer;

    const fitted = image.resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });

    let out;
    if (ext === ".png") out = await fitted.png({ compressionLevel: 9 }).toBuffer();
    else if (ext === ".webp") out = await fitted.webp({ quality: QUALITY }).toBuffer();
    else out = await fitted.jpeg({ quality: QUALITY, mozjpeg: true, progressive: true }).toBuffer();

    return out.length < buffer.length ? out : buffer;
  } catch (error) {
    console.warn(`  ! could not optimize, uploading as-is: ${error.message}`);
    return buffer;
  }
}

async function exists(key, sha) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.Metadata?.["source-sha256"] === sha;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function putObject(key, body, contentType, sha) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: CACHE_CONTROL,
      Metadata: { "source-sha256": sha },
    }),
  );
}

/**
 * Width variants for a large JPEG (`IMG_0437.jpg` → `IMG_0437-w800.jpg`).
 * Generated in-memory and uploaded under derived keys — never written to
 * public/, so they stay off the Vercel deployment bundle. Returns the list
 * of { key, bytes } uploaded (or skipped when unchanged).
 */
async function syncVariants(rel, raw, ext, counters) {
  if (![".jpg", ".jpeg"].includes(ext)) return;
  let width = 0;
  try {
    const meta = await sharp(raw, { failOn: "none" }).metadata();
    width = meta.width ?? 0;
  } catch {
    return;
  }
  const dot = rel.lastIndexOf(".");
  const base = rel.slice(0, dot);
  for (const variant of VARIANTS) {
    if (width <= variant.width) continue;
    const key = `${PREFIX}${base}${variant.suffix}.jpg`;
    let body;
    try {
      body = await sharp(raw, { failOn: "none" })
        .rotate()
        .resize({ width: variant.width, withoutEnlargement: true })
        .jpeg({ quality: variant.quality, mozjpeg: true, progressive: true })
        .toBuffer();
    } catch (error) {
      console.warn(`  ! variant failed for ${rel}: ${error.message}`);
      continue;
    }
    const sha = createHash("sha256").update(body).digest("hex");
    if (!force && !dryRun && (await exists(key, sha))) {
      counters.skipped += 1;
      continue;
    }
    if (dryRun) {
      counters.uploaded += 1;
      console.log(`would put ${key} (${body.length} bytes)`);
      continue;
    }
    await putObject(key, body, "image/jpeg", sha);
    counters.uploaded += 1;
    counters.cdnBytes += body.length;
  }
}

async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function main() {
  const files = [];
  for (const source of SOURCES) {
    const dir = path.join(PUBLIC_DIR, source);
    const found = await walk(dir);
    for (const file of found) {
      const rel = path.relative(PUBLIC_DIR, file).split(path.sep).join("/");
      if (only && !rel.includes(only)) continue;
      files.push({ file, rel });
    }
  }

  if (!files.length) {
    console.log("No files matched.");
    return;
  }

  let uploaded = 0;
  let skipped = 0;
  let sourceBytes = 0;
  let cdnBytes = 0;
  const seen = new Set();

  await pool(files, CONCURRENCY, async ({ file, rel }) => {
    const ext = path.extname(file).toLowerCase();
    const key = `${PREFIX}${rel}`;
    seen.add(key);

    const raw = await readFile(file);
    sourceBytes += raw.length;

    const body = await optimize(raw, ext);
    cdnBytes += body.length;

    const sha = createHash("sha256").update(raw).digest("hex");
    const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

    // Width variants upload under derived keys — track them as seen so
    // --prune never deletes them while the source still exists.
    const dot = rel.lastIndexOf(".");
    if ([".jpg", ".jpeg"].includes(ext)) {
      for (const variant of VARIANTS) {
        seen.add(`${PREFIX}${rel.slice(0, dot)}${variant.suffix}.jpg`);
      }
    }

    if (!force && !dryRun && (await exists(key, sha))) {
      skipped += 1;
      // Original unchanged, but variants may still be missing (new feature).
      const counters = { uploaded: 0, skipped: 0, cdnBytes: 0 };
      await syncVariants(rel, raw, ext, counters);
      uploaded += counters.uploaded;
      skipped += counters.skipped;
      cdnBytes += counters.cdnBytes;
      return;
    }

    if (dryRun) {
      uploaded += 1;
      const delta = raw.length - body.length;
      console.log(
        `would put ${key} (${raw.length} → ${body.length} bytes${delta > 0 ? `, -${Math.round((delta / raw.length) * 100)}%` : ""})`,
      );
      const counters = { uploaded: 0, skipped: 0, cdnBytes: 0 };
      await syncVariants(rel, raw, ext, counters);
      uploaded += counters.uploaded;
      return;
    }

    await putObject(key, body, contentType, sha);
    uploaded += 1;
    const counters = { uploaded: 0, skipped: 0, cdnBytes: 0 };
    await syncVariants(rel, raw, ext, counters);
    uploaded += counters.uploaded;
    skipped += counters.skipped;
    cdnBytes += counters.cdnBytes;
    if (uploaded % 25 === 0) console.log(`  … ${uploaded} uploaded`);
  });

  let pruned = 0;
  if (prune && !dryRun) {
    const listed = [];
    let token;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) if (!seen.has(object.Key)) listed.push(object.Key);
      token = page.NextContinuationToken;
    } while (token);

    for (let i = 0; i < listed.length; i += 1000) {
      const batch = listed.slice(i, i + 1000);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      pruned += batch.length;
    }
  }

  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    [
      "",
      `${dryRun ? "[dry-run] " : ""}source ${mb(sourceBytes)} → CDN ${mb(cdnBytes)}` +
        (sourceBytes ? ` (-${Math.round((1 - cdnBytes / sourceBytes) * 100)}%)` : ""),
      `uploaded ${uploaded}, unchanged ${skipped}${pruned ? `, pruned ${pruned}` : ""}`,
      publicBaseUrl ? `base: ${publicBaseUrl}` : "",
      `bucket: ${bucket}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

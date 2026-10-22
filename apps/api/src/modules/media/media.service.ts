import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { TenantDbService } from '../../common/prisma/tenant-db.service';

/** Keep in sync with multer limits + web compressProductImage. */
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

@Injectable()
export class MediaService {
  private readonly client: S3Client | null;
  private readonly bucket: string | null;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly tenantDb: TenantDbService) {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
    const bucket = process.env.R2_BUCKET?.trim();
    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim().replace(
      /\/+$/,
      '',
    );

    if (accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
      this.bucket = bucket;
      this.publicBaseUrl = publicBaseUrl;
    } else {
      this.client = null;
      this.bucket = null;
      this.publicBaseUrl = null;
    }
  }

  private assertConfigured(): {
    client: S3Client;
    bucket: string;
    publicBaseUrl: string;
  } {
    if (!this.client || !this.bucket || !this.publicBaseUrl) {
      throw new ServiceUnavailableException(
        'Product image upload is not configured (missing R2 env vars)',
      );
    }
    return {
      client: this.client,
      bucket: this.bucket,
      publicBaseUrl: this.publicBaseUrl,
    };
  }

  async uploadProductImage(file: {
    buffer: Buffer;
    mimetype: string;
    size: number;
    originalname?: string;
  }): Promise<{ url: string; key: string }> {
    const { client, bucket, publicBaseUrl } = this.assertConfigured();
    const tenantId = this.tenantDb.requireTenantId();

    if (!file?.buffer?.length) {
      throw new BadRequestException('No image file provided');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('Image must be 12MB or smaller');
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      throw new BadRequestException(
        'Image must be JPEG, PNG, WebP, AVIF, or GIF',
      );
    }

    const ext =
      EXT_BY_MIME[mime] ||
      file.originalname?.split('.').pop()?.toLowerCase() ||
      'jpg';
    const key = `tenants/${tenantId}/products/${randomUUID()}.${ext}`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.buffer,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    return { url: `${publicBaseUrl}/${key}`, key };
  }

  /** Best-effort delete when replacing an R2-hosted product image. */
  async deleteIfOwned(url: string | null | undefined): Promise<void> {
    if (!url?.trim() || !this.client || !this.bucket || !this.publicBaseUrl) {
      return;
    }
    const base = this.publicBaseUrl;
    if (!url.startsWith(`${base}/`)) return;
    const key = url.slice(base.length + 1);
    if (!key.startsWith('tenants/')) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      /* ignore orphan cleanup failures */
    }
  }
}

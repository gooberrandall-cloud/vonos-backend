import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { MediaService } from './media.service';

const ALLOWED_HOST_SUFFIXES = [
  '.vonosautos.com',
  '.vonosautomarket.com',
  'vonosautos.com',
  'vonosautomarket.com',
] as const;

function isAllowedLegacyMediaUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(suffix),
  );
  if (!allowed) return null;
  // Only proxy product/media upload paths — never arbitrary pages.
  if (!parsed.pathname.includes('/uploads/')) return null;
  return parsed;
}

/**
 * Proxy legacy Ultimate POS product images. Those hosts hotlink-block our
 * app origin (browser <img> → 403); server fetch with their own Referer works.
 * Also accepts authenticated product image uploads to R2.
 */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload')
  @UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
  @Roles('staff', 'manager', 'admin', 'super_admin')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile()
    file?: {
      buffer: Buffer;
      mimetype: string;
      size: number;
      originalname: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.media.uploadProductImage(file);
  }

  @Get('legacy')
  @Header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')
  async legacy(
    @Query('url') url: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!url?.trim()) {
      throw new BadRequestException('url is required');
    }
    const target = isAllowedLegacyMediaUrl(url.trim());
    if (!target) {
      throw new BadRequestException('url host/path not allowed');
    }

    const upstream = await fetch(target.toString(), {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (compatible; VonosMediaProxy/1.0; +https://vonosgroup.com)',
        Referer: `${target.origin}/`,
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      res.status(upstream.status === 404 ? 404 : 502).end();
      return;
    }

    const contentType =
      upstream.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
      res.status(502).end();
      return;
    }

    res.setHeader('Content-Type', contentType);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Length', String(buf.byteLength));
    res.status(200).end(buf);
  }
}

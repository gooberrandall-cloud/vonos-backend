import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CmsService } from './cms.service';

/** Public blog/content — no JWT. */
@Controller('public/cms')
export class PublicCmsController {
  constructor(private readonly cms: CmsService) {}

  @Get('posts')
  listPosts(
    @Query('tenant') tenant?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cms.listPublicPosts({
      tenantCode: tenant,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('posts/:slug')
  async getPost(@Param('slug') slug: string, @Query('tenant') tenant?: string) {
    try {
      return await this.cms.getPublicPostBySlug(slug, tenant);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw error;
    }
  }
}

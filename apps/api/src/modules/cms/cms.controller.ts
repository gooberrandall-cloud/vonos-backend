import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CmsPostStatus } from '@prisma/client';
import type { CreateCmsPostInput, UpdateCmsPostInput } from '@vonos/types';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { CmsService } from './cms.service';

@Controller('cms')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class CmsController {
  constructor(private readonly cms: CmsService) {}

  @Get('posts')
  @Roles('manager', 'admin', 'super_admin')
  listPosts(
    @Query('scope') scope?: string,
    @Query('status') status?: CmsPostStatus,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cms.listPosts({
      scope,
      status,
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('posts/:id')
  @Roles('manager', 'admin', 'super_admin')
  getPost(@Param('id') id: string, @Query('scope') scope?: string) {
    return this.cms.getPost(id, scope);
  }

  @Post('posts')
  @Roles('admin', 'super_admin')
  createPost(
    @Body() body: CreateCmsPostInput,
    @Query('scope') scope?: string,
  ) {
    return this.cms.createPost(body, scope);
  }

  @Patch('posts/:id')
  @Roles('admin', 'super_admin')
  updatePost(
    @Param('id') id: string,
    @Body() body: UpdateCmsPostInput,
    @Query('scope') scope?: string,
  ) {
    return this.cms.updatePost(id, body, scope);
  }

  @Delete('posts/:id')
  @Roles('admin', 'super_admin')
  deletePost(@Param('id') id: string, @Query('scope') scope?: string) {
    return this.cms.deletePost(id, scope);
  }
}

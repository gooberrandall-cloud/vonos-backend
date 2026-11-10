import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Request } from 'express';
import type { CmsPostStatus, Prisma } from '@prisma/client';
import type {
  CmsPost,
  CmsPostListPage,
  CmsPostSummary,
  CreateCmsPostInput,
  UpdateCmsPostInput,
} from '@vonos/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantDbService } from '../../common/prisma/tenant-db.service';
import {
  buildCompositeCursorQuery,
  decodeCompositeCursor,
  encodeCompositeCursor,
} from '../../common/utils/pagination';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { userCanAccessVagPortal } from '../../common/utils/vagPortalAccess';

const GROUP_SCOPE = 'group';

type VonosRequest = Request & { user?: AuthenticatedUser };

type ScopeContext = {
  scopeKey: string;
  tenantId: string | null;
};

type RawPost = Prisma.CmsPostGetPayload<{ include: { sections: true } }>;

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function computeReadMinutes(intro: string[], sections: { paragraphs: string[] }[]): number {
  const text = [
    ...intro,
    ...sections.flatMap((section) => section.paragraphs),
  ].join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function serializeSection(section: RawPost['sections'][number]) {
  return {
    id: section.id,
    sectionId: section.sectionId,
    sortOrder: section.sortOrder,
    title: section.title,
    paragraphs: section.paragraphs as string[],
  };
}

function serializePost(row: RawPost): CmsPost {
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    tenantId: row.tenantId,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    category: row.category,
    coverImageUrl: row.coverImageUrl,
    author: row.author,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    readMinutes: row.readMinutes,
    intro: row.intro as string[],
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sections: row.sections
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(serializeSection),
  };
}

function serializeSummary(row: RawPost): CmsPostSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    category: row.category,
    coverImageUrl: row.coverImageUrl,
    author: row.author,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    readMinutes: row.readMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class CmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDbService,
    @Inject(REQUEST) private readonly request: VonosRequest,
  ) {}

  resolveScope(scope?: string): ScopeContext {
    const user = this.request.user;
    const resolvedTenantId = this.tenantDb.resolveTenantId();
    const wantsGroup = scope === 'group' || scope === GROUP_SCOPE;

    if (wantsGroup) {
      if (!user || !userCanAccessVagPortal(user)) {
        throw new ForbiddenException('Group CMS requires VAG access');
      }
      return { scopeKey: GROUP_SCOPE, tenantId: null };
    }

    if (resolvedTenantId) {
      return { scopeKey: resolvedTenantId, tenantId: resolvedTenantId };
    }

    if (user?.role === 'super_admin') {
      return { scopeKey: GROUP_SCOPE, tenantId: null };
    }

    throw new BadRequestException(
      'Tenant context required for tenant-scoped CMS content',
    );
  }

  async listPosts(input: {
    scope?: string;
    status?: CmsPostStatus;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CmsPostListPage> {
    const { scopeKey } = this.resolveScope(input.scope);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const sortField = 'updatedAt';
    const sortDir = 'desc';
    const pagination = buildCompositeCursorQuery({
      cursor: input.cursor,
      limit,
      sortField,
      sortDir,
      sortValueType: 'date',
    });

    const where: Prisma.CmsPostWhereInput = {
      scopeKey,
      deletedAt: null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.search?.trim()
        ? {
            OR: [
              { title: { contains: input.search.trim(), mode: 'insensitive' } },
              { slug: { contains: input.search.trim(), mode: 'insensitive' } },
              { category: { contains: input.search.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(pagination.where ?? {}),
    };

    const rows = await this.prisma.cmsPost.findMany({
      where,
      include: { sections: true },
      orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
      take: pagination.take,
    });

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last
        ? encodeCompositeCursor({
            sortValue: last.updatedAt.toISOString(),
            id: last.id,
          })
        : null;

    return {
      items: rows.map(serializeSummary),
      nextCursor,
    };
  }

  async getPost(id: string, scope?: string): Promise<CmsPost> {
    const { scopeKey } = this.resolveScope(scope);
    const row = await this.prisma.cmsPost.findFirst({
      where: { id, scopeKey, deletedAt: null },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Post not found');
    return serializePost(row);
  }

  async createPost(input: CreateCmsPostInput, scope?: string): Promise<CmsPost> {
    const { scopeKey, tenantId } = this.resolveScope(scope);
    const slug = slugify(input.slug?.trim() || input.title);
    if (!slug) throw new BadRequestException('Slug is required');

    const existing = await this.prisma.cmsPost.findFirst({
      where: { scopeKey, slug, deletedAt: null },
    });
    if (existing) {
      throw new BadRequestException(`Slug "${slug}" already exists in this scope`);
    }

    const status = input.status ?? 'draft';
    const readMinutes = computeReadMinutes(input.intro, input.sections);
    const publishedAt =
      status === 'published'
        ? input.publishedAt
          ? new Date(input.publishedAt)
          : new Date()
        : null;

    const row = await this.prisma.cmsPost.create({
      data: {
        scopeKey,
        tenantId,
        slug,
        title: input.title.trim(),
        excerpt: input.excerpt.trim(),
        category: input.category.trim(),
        coverImageUrl: input.coverImageUrl.trim(),
        author: input.author?.trim() || 'Vonos Workshop',
        status,
        publishedAt,
        readMinutes,
        intro: input.intro,
        sortOrder: input.sortOrder ?? 0,
        sections: {
          create: input.sections.map((section, index) => ({
            sectionId: section.sectionId || slugify(section.title) || `section-${index + 1}`,
            sortOrder: index,
            title: section.title.trim(),
            paragraphs: section.paragraphs.filter((p) => p.trim()),
          })),
        },
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    });

    return serializePost(row);
  }

  async updatePost(
    id: string,
    input: UpdateCmsPostInput,
    scope?: string,
  ): Promise<CmsPost> {
    const { scopeKey } = this.resolveScope(scope);
    const existing = await this.prisma.cmsPost.findFirst({
      where: { id, scopeKey, deletedAt: null },
      include: { sections: true },
    });
    if (!existing) throw new NotFoundException('Post not found');

    const nextSlug = input.slug
      ? slugify(input.slug)
      : input.title
        ? slugify(input.title)
        : existing.slug;

    if (nextSlug !== existing.slug) {
      const conflict = await this.prisma.cmsPost.findFirst({
        where: { scopeKey, slug: nextSlug, deletedAt: null, NOT: { id } },
      });
      if (conflict) {
        throw new BadRequestException(`Slug "${nextSlug}" already exists in this scope`);
      }
    }

    const intro = input.intro ?? (existing.intro as string[]);
    const sectionsInput =
      input.sections ??
      existing.sections
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((section) => ({
          sectionId: section.sectionId,
          title: section.title,
          paragraphs: section.paragraphs as string[],
        }));

    const status = input.status ?? existing.status;
    let publishedAt = existing.publishedAt;
    if (status === 'published' && !publishedAt) {
      publishedAt = input.publishedAt ? new Date(input.publishedAt) : new Date();
    }
    if (status === 'draft') {
      publishedAt = null;
    }
    if (input.publishedAt && status === 'published') {
      publishedAt = new Date(input.publishedAt);
    }

    const readMinutes = computeReadMinutes(intro, sectionsInput);

    await this.prisma.$transaction(async (tx) => {
      await tx.cmsPostSection.deleteMany({ where: { postId: id } });
      await tx.cmsPost.update({
        where: { id },
        data: {
          slug: nextSlug,
          title: input.title?.trim() ?? existing.title,
          excerpt: input.excerpt?.trim() ?? existing.excerpt,
          category: input.category?.trim() ?? existing.category,
          coverImageUrl: input.coverImageUrl?.trim() ?? existing.coverImageUrl,
          author: input.author?.trim() ?? existing.author,
          status,
          publishedAt,
          readMinutes,
          intro,
          sortOrder: input.sortOrder ?? existing.sortOrder,
          sections: {
            create: sectionsInput.map((section, index) => ({
              sectionId: section.sectionId || slugify(section.title) || `section-${index + 1}`,
              sortOrder: index,
              title: section.title.trim(),
              paragraphs: section.paragraphs.filter((p) => p.trim()),
            })),
          },
        },
      });
    });

    return this.getPost(id, scope);
  }

  async deletePost(id: string, scope?: string): Promise<{ ok: true }> {
    const { scopeKey } = this.resolveScope(scope);
    const existing = await this.prisma.cmsPost.findFirst({
      where: { id, scopeKey, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Post not found');
    await this.prisma.cmsPost.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async listPublicPosts(input: {
    tenantCode?: string;
    limit?: number;
    cursor?: string;
  }): Promise<CmsPostListPage> {
    const scopeKey = await this.resolvePublicScopeKey(input.tenantCode);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const sortField = 'publishedAt';
    const sortDir = 'desc';
    const pagination = buildCompositeCursorQuery({
      cursor: input.cursor,
      limit,
      sortField,
      sortDir,
      sortValueType: 'date',
    });

    const rows = await this.prisma.cmsPost.findMany({
      where: {
        scopeKey,
        status: 'published',
        deletedAt: null,
        publishedAt: { not: null },
        ...(pagination.where ?? {}),
      },
      include: { sections: true },
      orderBy: [{ [sortField]: sortDir }, { id: sortDir }],
      take: pagination.take,
    });

    const last = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && last?.publishedAt
        ? encodeCompositeCursor({
            sortValue: last.publishedAt.toISOString(),
            id: last.id,
          })
        : null;

    return {
      items: rows.map(serializeSummary),
      nextCursor,
    };
  }

  async getPublicPostBySlug(
    slug: string,
    tenantCode?: string,
  ): Promise<CmsPost> {
    const scopeKey = await this.resolvePublicScopeKey(tenantCode);
    const row = await this.prisma.cmsPost.findFirst({
      where: {
        scopeKey,
        slug,
        status: 'published',
        deletedAt: null,
      },
      include: { sections: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!row) throw new NotFoundException('Post not found');
    return serializePost(row);
  }

  private async resolvePublicScopeKey(tenantCode?: string): Promise<string> {
    const code = tenantCode?.trim().toUpperCase();
    if (!code || code === 'GROUP') return GROUP_SCOPE;
    const tenant = await this.prisma.tenant.findFirst({
      where: { code, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant.id;
  }
}

import type { PrismaClient } from '@prisma/client';
import { BLOG_POSTS } from '../../../web/lib/marketing/blog-posts';

export async function seedCmsPosts(prisma: PrismaClient): Promise<void> {
  for (const [index, post] of BLOG_POSTS.entries()) {
    const publishedAt = new Date(post.publishedAt);
    const existing = await prisma.cmsPost.findUnique({
      where: {
        scopeKey_slug: {
          scopeKey: 'group',
          slug: post.slug,
        },
      },
    });

    if (existing) {
      await prisma.$transaction(async (tx) => {
        await tx.cmsPostSection.deleteMany({ where: { postId: existing.id } });
        await tx.cmsPost.update({
          where: { id: existing.id },
          data: {
            title: post.title,
            excerpt: post.excerpt,
            category: post.category,
            coverImageUrl: post.image,
            author: post.author,
            status: 'published',
            publishedAt,
            readMinutes: post.readMinutes,
            intro: post.intro,
            sortOrder: index,
            deletedAt: null,
            sections: {
              create: post.sections.map((section, sectionIndex) => ({
                sectionId: section.id,
                sortOrder: sectionIndex,
                title: section.title,
                paragraphs: section.paragraphs,
              })),
            },
          },
        });
      });
      continue;
    }

    await prisma.cmsPost.create({
      data: {
        scopeKey: 'group',
        tenantId: null,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        category: post.category,
        coverImageUrl: post.image,
        author: post.author,
        status: 'published',
        publishedAt,
        readMinutes: post.readMinutes,
        intro: post.intro,
        sortOrder: index,
        sections: {
          create: post.sections.map((section, sectionIndex) => ({
            sectionId: section.id,
            sortOrder: sectionIndex,
            title: section.title,
            paragraphs: section.paragraphs,
          })),
        },
      },
    });
  }
}

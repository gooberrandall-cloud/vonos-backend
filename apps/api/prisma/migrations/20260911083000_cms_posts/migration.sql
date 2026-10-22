-- CreateEnum
CREATE TYPE "CmsPostStatus" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "CmsPost" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT 'group',
    "tenantId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "coverImageUrl" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'Vonos Workshop',
    "status" "CmsPostStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "readMinutes" INTEGER NOT NULL DEFAULT 5,
    "intro" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CmsPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmsPostSection" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "paragraphs" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmsPostSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmsPost_scopeKey_status_publishedAt_idx" ON "CmsPost"("scopeKey", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "CmsPost_tenantId_status_idx" ON "CmsPost"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CmsPost_scopeKey_slug_key" ON "CmsPost"("scopeKey", "slug");

-- CreateIndex
CREATE INDEX "CmsPostSection_postId_sortOrder_idx" ON "CmsPostSection"("postId", "sortOrder");

-- AddForeignKey
ALTER TABLE "CmsPost" ADD CONSTRAINT "CmsPost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmsPostSection" ADD CONSTRAINT "CmsPostSection_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CmsPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

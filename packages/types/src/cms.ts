export type CmsPostStatus = "draft" | "published";

export type CmsPostSection = {
  id?: string;
  sectionId: string;
  sortOrder: number;
  title: string;
  paragraphs: string[];
};

export type CmsPost = {
  id: string;
  scopeKey: string;
  tenantId: string | null;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  coverImageUrl: string;
  author: string;
  status: CmsPostStatus;
  publishedAt: string | null;
  readMinutes: number;
  intro: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  sections: CmsPostSection[];
};

export type CmsPostSummary = Pick<
  CmsPost,
  | "id"
  | "slug"
  | "title"
  | "excerpt"
  | "category"
  | "coverImageUrl"
  | "author"
  | "status"
  | "publishedAt"
  | "readMinutes"
  | "createdAt"
  | "updatedAt"
>;

export type CmsPostListPage = {
  items: CmsPostSummary[];
  nextCursor: string | null;
};

export type CreateCmsPostInput = {
  slug?: string;
  title: string;
  excerpt: string;
  category: string;
  coverImageUrl: string;
  author?: string;
  status?: CmsPostStatus;
  publishedAt?: string | null;
  intro: string[];
  sections: Array<{
    sectionId: string;
    title: string;
    paragraphs: string[];
  }>;
  sortOrder?: number;
};

export type UpdateCmsPostInput = Partial<CreateCmsPostInput>;

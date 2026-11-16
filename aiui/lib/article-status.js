export const articleStatuses = ['published', 'draft', 'all'];
export const statusLabels = { published: '已发布', draft: '草稿', all: '全部' };
export const articleDate = (article) => article.publishedAt ?? article.updatedAt ?? '';
export function filterArticleStatus(items, status = 'published') {
  return items.filter((item) => status === 'all' || (item.status ?? 'published') === status);
}

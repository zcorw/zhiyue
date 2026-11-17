// 演示和预览使用的基础匹配，不调用浏览器麦克风或第三方服务。
export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

export function searchDemo(items, text) {
  const raw = text.trim().replace(/[。！？!?]+$/u, '');
  const normalized = normalizeSearch(raw);
  if (/^(?:返回|显示|查看|打开)?全部文章$/.test(normalized)) {
    return { items, total: items.length, offset: 0, kind: 'all', filters: { q: '', category: '' }, label: '全部文章' };
  }
  const articleCommand = /^(?:请)?(?:帮我|给我)?(?:(?:查找|搜索|检索|查看|打开|阅读|找)(?:一下)?)?文章/u.test(raw) || /[《「]/u.test(raw);
  const categories = [...new Set(items.map((item) => item.category?.name).filter(Boolean))];
  const category = !articleCommand && categories.find((name) => [name, `${name}分类`, `${name}类`, `${name}的文章`]
    .some((value) => normalizeSearch(value) === normalized.replace(/^(?:请)?(?:查找|搜索|检索|查看|打开)/u, '')));
  if (!articleCommand && !category && (/分类$/.test(normalized) || /^分类/.test(normalized.replace(/^(?:请)?(?:查找|搜索|检索|查看|打开)/u, '')))) {
    return categoryPage(demoNavigation(items));
  }
  const query = raw.replace(/^(?:请)?(?:帮我|给我)?(?:查找|搜索|检索|查看|打开|阅读|找)(?:一下)?(?:文章)?\s*/u, '')
    .replace(/^文章\s*/u, '').replace(/[《》「」]/gu, '').trim();
  const matches = category ? items.filter((item) => item.category?.name === category)
    : items.filter((item) => query && normalizeSearch(item.title).includes(normalizeSearch(query)));
  return { items: matches, total: matches.length, offset: 0, kind: category ? 'category' : 'article',
    filters: { q: query, category: category ?? '' }, label: category ?? `检索：${query}` };
}

// 只使用当前账号可读发布内容的分类导航，不从首屏文章猜测完整分类。
export function categoryPage(navigation) {
  if (!Array.isArray(navigation?.categories)
      || !Number.isSafeInteger(navigation.uncategorizedCount) || navigation.uncategorizedCount < 0) {
    throw new Error('category_navigation_unavailable');
  }
  const choices = new Map();
  for (const category of navigation.categories) {
    if (typeof category?.id !== 'string' || !category.id || category.id.length > 64
        || typeof category.name !== 'string' || !category.name.trim()
        || !Number.isSafeInteger(category.articleCount) || category.articleCount < 0) {
      throw new Error('category_navigation_invalid');
    }
    if (category.articleCount > 0) choices.set(category.id, { ...category });
  }
  if (navigation.uncategorizedCount > 0) choices.set('uncategorized',
    { id: 'uncategorized', name: '未分类', articleCount: navigation.uncategorizedCount });
  const items = [...choices.values()].map(({ id, name, articleCount }) =>
    ({ id, title: name, categoryCount: articleCount, publishedAt: '', hasAudio: false }));
  return { items, total: items.length, offset: 0, kind: 'categories', label: '全部分类',
    filters: { q: '', category: '' }, noMatch: false };
}

export function demoNavigation(items) {
  const categories = new Map();
  let uncategorizedCount = 0;
  for (const item of items) {
    const category = item.category;
    if (!category?.id || !category?.name) { uncategorizedCount++; continue; }
    const entry = categories.get(category.id) ?? { id: category.id, name: category.name, articleCount: 0 };
    entry.articleCount++;
    categories.set(category.id, entry);
  }
  return { categories: [...categories.values()], uncategorizedCount };
}

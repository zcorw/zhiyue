// 演示和预览使用的基础匹配，不调用浏览器麦克风或第三方服务。
export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function stripCommand(value) {
  return value.replace(/^(?:请)?(?:帮我|给我)?(?:(?:查找|搜索|检索|查看|打开|阅读|找)(?:一下)?)?\s*/u, '').trim();
}

// 明确文章口令和引用标题优先，避免“垃圾分类”等文章名被当成分类口令。
export function parseSearchIntent(text) {
  const raw = String(text ?? '').trim().replace(/[。！？!?]+$/u, '');
  if (/^(?:返回|显示|查看|打开)?全部文章$/.test(normalizeSearch(raw))) return { kind: 'all', query: '' };
  const value = stripCommand(raw);
  if (/^文章/u.test(value) || /[《「]/u.test(raw)) {
    return { kind: 'article', query: value.replace(/^文章\s*/u, '').replace(/[《》「」]/gu, '').trim() };
  }
  if (/^分类/u.test(value)) return { kind: 'category', query: value.replace(/^分类\s*/u, '').trim() };
  if (/(?:分类|类|的文章)$/u.test(value)) {
    return { kind: 'category', query: value.replace(/(?:分类|类|的文章)$/u, '').trim() };
  }
  return { kind: 'auto', query: value };
}

function rankedMatches(items, query, name) {
  const normalized = normalizeSearch(query);
  if (!normalized) return [];
  const exact = [], partial = [];
  for (const item of items) {
    const value = normalizeSearch(name(item));
    if (value === normalized) exact.push(item);
    else if (value.includes(normalized)) partial.push(item);
  }
  return [...exact, ...partial];
}

export function searchDemo(items, text) {
  const intent = parseSearchIntent(text);
  if (intent.kind === 'all') {
    return { items, total: items.length, offset: 0, kind: 'all', filters: { q: '', category: '' }, label: '全部文章' };
  }
  if (intent.kind !== 'article') {
    const navigation = demoNavigation(items);
    const rawName = String(text ?? '').trim().replace(/[。！？!?]+$/u, '');
    const namedCategory = navigation.categories.some((item) => normalizeSearch(item.name) === normalizeSearch(rawName));
    const choices = categorySearchPage(navigation, text);
    if (intent.kind === 'category' || namedCategory || (normalizeSearch(intent.query) && !choices.noMatch)) {
      if (choices.total !== 1 || choices.noMatch) return choices;
      const category = choices.items[0];
      const matches = items.filter((item) => (item.category?.id ?? 'uncategorized') === category.id);
      return { items: matches, total: matches.length, offset: 0, kind: 'category',
        filters: { q: '', category: category.id }, label: category.title };
    }
  }
  const matches = rankedMatches(items, intent.query, (item) => item.title);
  return { items: matches, total: matches.length, offset: 0, kind: 'article',
    filters: { q: intent.query, category: '' }, label: `检索：${intent.query}` };
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

// 在完整、已授权的导航内匹配；候选保留精确id，同名分类不得按名称合并。
export function categorySearchPage(navigation, text) {
  const page = categoryPage(navigation);
  const intent = parseSearchIntent(text);
  const originalName = String(text ?? '').trim().replace(/[。！？!?]+$/u, '');
  const rawName = stripCommand(originalName);
  // 分类名本身可能以“分类”结尾，完整名称命中时保留其语义。
  const query = page.items.some((item) => normalizeSearch(item.title) === normalizeSearch(originalName)) ? originalName
    : page.items.some((item) => normalizeSearch(item.title) === normalizeSearch(rawName)) ? rawName : intent.query;
  if (!normalizeSearch(query)) return page;
  const matches = rankedMatches(page.items, query, (item) => item.title);
  if (!matches.length) return { ...page, noMatch: true };
  return { ...page, items: matches, total: matches.length, label: `分类：${query}`, noMatch: false };
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

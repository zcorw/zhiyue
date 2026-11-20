import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryPage, categorySearchPage, demoNavigation, parseSearchIntent, searchDemo } from '../aiui/lib/search.js';

const navigation = {
  categories: [
    { id: 'science', name: '科学', articleCount: 4 },
    { id: 'exact-a', name: '科', articleCount: 2 },
    { id: 'history', name: '科学史', articleCount: 1 },
    { id: 'exact-b', name: '科', articleCount: 3 },
    { id: 'empty', name: '科技', articleCount: 0 },
  ],
  uncategorizedCount: 1,
};

test('部分分类名产生完整候选，精确命中优先且同名不同id都保留', () => {
  const result = categorySearchPage(navigation, '查看科分类');
  assert.deepEqual(result.items.map((item) => item.id), ['exact-a', 'exact-b', 'science', 'history']);
  assert.equal(result.kind, 'categories');
  assert.equal(result.total, 4);
  assert.equal(result.noMatch, false);
  assert.deepEqual(result.filters, { q: '', category: '' });
  assert.equal(result.items.find((item) => item.id === 'science').categoryCount, 4);
  assert.deepEqual(categorySearchPage(navigation, '分类科'), result);
  assert.equal(navigation.categories[0].id, 'science', '排序不改变完整导航');
});

test('分类没有命中时回退全部可读分类，未分类保留而空分类不显示', () => {
  const result = categorySearchPage(navigation, '查看不存在分类');
  assert.equal(result.label, '全部分类');
  assert.equal(result.noMatch, true);
  assert.deepEqual(result.items.map((item) => item.id), ['science', 'exact-a', 'history', 'exact-b', 'uncategorized']);
  assert.equal(categorySearchPage(navigation, '未分类').items[0].id, 'uncategorized');
  assert.deepEqual(categorySearchPage(navigation, '分类'), categoryPage(navigation));
});

test('分类使用名称规范化匹配，名称自身含分类后缀时完整名称仍优先', () => {
  const nav = { categories: [
    { id: 'short', name: '垃圾', articleCount: 1 },
    { id: 'complete', name: '垃圾分类', articleCount: 1 },
    { id: 'wide', name: 'ＡＩ 科学', articleCount: 1 },
  ], uncategorizedCount: 0 };
  assert.deepEqual(categorySearchPage(nav, '查看垃圾分类').items.map((item) => item.id), ['complete']);
  assert.deepEqual(categorySearchPage(nav, '分类ai科学').items.map((item) => item.id), ['wide']);
});

test('候选检索仍严格校验完整导航，不接纳非法计数或从未授权内容生成分类', () => {
  assert.throws(() => categorySearchPage(null, '科'), /category_navigation_unavailable/);
  assert.throws(() => categorySearchPage({ categories: [{ id: 'x', name: '科', articleCount: -1 }], uncategorizedCount: 0 }, '科'), /category_navigation_invalid/);
  assert.throws(() => categorySearchPage({ categories: [], uncategorizedCount: 0.5 }, '科'), /category_navigation_unavailable/);
  assert.equal(categorySearchPage({ categories: [], uncategorizedCount: 0 }, '科').total, 0);
});

const articles = [
  { id: 'partial-first', title: '第一班电车之前', category: { id: 'science', name: '科学' } },
  { id: 'exact', title: '电车', category: { id: 'technology', name: '科技' } },
  { id: 'partial-last', title: '电车之后', category: { id: 'science', name: '科学' } },
  { id: 'classification', title: '垃圾分类' },
];

test('部分文章标题匹配全部结果，精确标题排在部分标题之前', () => {
  const result = searchDemo(articles, '查找文章电车');
  assert.equal(result.kind, 'article');
  assert.deepEqual(result.items.map((item) => item.id), ['exact', 'partial-first', 'partial-last']);
  assert.deepEqual(result.filters, { q: '电车', category: '' });
  assert.equal(searchDemo(articles, '查找文章电車').total, 0, '不把错字或异体字当作已确认的等价名称');
  assert.deepEqual(searchDemo([{ id: 'wide', title: 'ＡＩ · 入门' }], '文章ai入门').items.map((item) => item.id), ['wide']);
});

test('明确文章口令和引用标题含分类字样时不回退分类', () => {
  for (const query of ['查找文章垃圾分类', '文章垃圾分类', '查找《垃圾分类》']) {
    assert.deepEqual(searchDemo(articles, query).items.map((item) => item.id), ['classification']);
    assert.equal(searchDemo(articles, query).kind, 'article');
  }
  for (const query of ['查找文章不存在分类', '不存在标题', '']) {
    const result = searchDemo(articles, query);
    assert.equal(result.kind, 'article');
    assert.equal(result.total, 0);
  }
});

test('演示多分类命中交给用户选择，唯一分类以精确id读取文章', () => {
  for (const query of ['查看科分类', '分类科', '科']) {
    const result = searchDemo(articles, query);
    assert.equal(result.kind, 'categories');
    assert.deepEqual(result.items.map((item) => item.id), ['science', 'technology']);
  }
  const result = searchDemo(articles, '查看科学分类');
  assert.equal(result.kind, 'category');
  assert.deepEqual(result.filters, { q: '', category: 'science' });
  assert.deepEqual(result.items.map((item) => item.id), ['partial-first', 'partial-last']);
  assert.equal(searchDemo(articles, '查看不存在分类').kind, 'categories');
  assert.equal(searchDemo(articles, '查看不存在分类').noMatch, true);
});

test('演示不按相同分类名合并不同id，未分类可通过保留id选择', () => {
  const sameName = [
    { id: 'a', title: '甲', category: { id: 'first', name: '科学' } },
    { id: 'b', title: '乙', category: { id: 'second', name: '科学' } },
  ];
  assert.equal(demoNavigation(sameName).categories.length, 2);
  assert.deepEqual(searchDemo(sameName, '查看科学分类').items.map((item) => item.id), ['first', 'second']);
  const uncategorized = searchDemo(articles, '查看未分类');
  assert.equal(uncategorized.kind, 'category');
  assert.equal(uncategorized.filters.category, 'uncategorized');
  assert.deepEqual(uncategorized.items.map((item) => item.id), ['classification']);
});

test('共享口令解析保留文章与分类的明确意图', () => {
  assert.deepEqual(parseSearchIntent('请帮我查看科分类！'), { kind: 'category', query: '科' });
  assert.deepEqual(parseSearchIntent('分类科'), { kind: 'category', query: '科' });
  assert.deepEqual(parseSearchIntent('查找文章电车'), { kind: 'article', query: '电车' });
  assert.deepEqual(parseSearchIntent('查看科学的文章'), { kind: 'category', query: '科学' });
  assert.deepEqual(parseSearchIntent('显示全部文章'), { kind: 'all', query: '' });
});

test('分类名本身是阅读等动词时，直接说名称仍按分类匹配', () => {
  const items = [
    { id: 'read', title: '纸上的光', category: { id: 'reading', name: '阅读' } },
    { id: 'notes', title: '笔记', category: { id: 'notes', name: '阅读笔记' } },
  ];
  const result = searchDemo(items, '阅读');
  assert.equal(result.kind, 'categories');
  assert.deepEqual(result.items.map((item) => item.id), ['reading', 'notes']);
  assert.equal(searchDemo(items.slice(0, 1), '阅读').filters.category, 'reading');
});

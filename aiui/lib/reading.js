import { articles } from '../data/articles.js';

export const rowsPerScreen = 3;

export function getArticle(id) {
  return articles.find((article) => article.id === id) ?? null;
}

export function getLibraryView(requestedIndex, { items = articles, offset = 0, total = items.length } = {}) {
  const selectedIndex = Math.min(Math.max(0, requestedIndex), Math.max(0, total - 1));
  const start = Math.floor(selectedIndex / rowsPerScreen) * rowsPerScreen;
  return {
    selectedIndex,
    selectedId: items[selectedIndex - offset]?.id ?? '',
    countLabel: total ? `${selectedIndex + 1} / ${total}` : '0 篇',
    screenStart: start,
    screenEnd: Math.min(start + rowsPerScreen, total),
    listPageLabel: total ? `${Math.floor(start / rowsPerScreen) + 1} / ${Math.ceil(total / rowsPerScreen)}` : '0 / 0',
    canPreviousListPage: start > 0,
    canNextListPage: start + rowsPerScreen < total,
    pageFocus: '',
    rows: items.slice(start - offset, start - offset + rowsPerScreen).map((article, index) => ({
      id: article.id,
      title: article.title,
      date: article.publishedAt.slice(0, 10),
      audioLabel: (article.hasAudio ?? Boolean(article.audio)) ? '有音频' : '纯文字',
      selected: start + index === selectedIndex,
    })),
  };
}

export function getArticleIndex(id) {
  return articles.findIndex((article) => article.id === id);
}

export function paginate(paragraphs, options) {
  return layoutText(paragraphs, options).map((page) => page.text);
}

export function layoutText(paragraphs, { width, height, lineHeight, measureText } = {}) {
  if (![width, height, lineHeight].every((value) => Number.isFinite(value) && value > 0)
      || height < lineHeight || typeof measureText !== 'function') throw new Error('layout_unavailable');
  const text = paragraphs.join('\n').replace(/\r\n?/g, '\n');
  if (!text) return [];
  const characters = typeof globalThis.Intl?.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
    : Array.from(text).reduce((result, character) => {
      // 旧宿主保留组合音标、变体和ZWJ连接，不拆开代理对。
      if (result.length && (/^[\p{M}\uFE0F\u200D]$/u.test(character) || result[result.length - 1].endsWith('\u200D'))) result[result.length - 1] += character;
      else result.push(character);
      return result;
    }, []);
  const linesPerPage = Math.floor(height / lineHeight);
  const pages = [];
  let pageLines = [];
  let start = 0, cursor = 0, lines = 0;
  let newline = characters.indexOf('\n');
  const fits = (from, end) => {
    const measured = measureText(characters.slice(from, end).join(''));
    if (!Number.isFinite(measured) || measured < 0) throw new Error('layout_unavailable');
    return measured <= width;
  };
  while (cursor < characters.length) {
    const limit = newline < 0 ? characters.length : newline;
    let end = cursor;
    if (cursor < limit) {
      let high = Math.min(limit, cursor + 8);
      while (fits(cursor, high)) {
        end = high;
        if (high === limit) break;
        high = Math.min(limit, cursor + (high - cursor) * 2);
      }
      let low = end;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(cursor, middle)) low = middle;
        else high = middle - 1;
      }
      end = low;
      if (end === cursor) throw new Error('layout_too_narrow');
    }
    pageLines.push(characters.slice(cursor, end).join(''));
    if (end === newline) {
      end++;
      newline = characters.indexOf('\n', end);
    }
    cursor = end;
    lines++;
    if (lines === linesPerPage || cursor === characters.length) {
      pages.push({ text: characters.slice(start, cursor).join(''), lines: pageLines });
      start = cursor;
      lines = 0;
      pageLines = [];
    }
  }
  return pages;
}

export function pageAtOffset(pages, offset = 0) {
  let start = 0;
  for (let index = 0; index < pages.length; index++) {
    start += pages[index].length;
    if (offset < start) return index;
  }
  return Math.max(0, pages.length - 1);
}

import { articles } from '../data/articles.js';

const rowsPerScreen = 3;
const charactersPerPage = 84;
const sentenceEnd = /[。！？.!?]/;
const closingPunctuation = /[，。！？、；：」』）】”’…,.!?]/;

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

export function paginate(paragraphs) {
  const pages = [];
  for (const paragraph of paragraphs) {
    const characters = Array.from(paragraph.trim());
    let start = 0;
    while (start < characters.length) {
      let end = Math.min(start + charactersPerPage, characters.length);
      if (end < characters.length) {
        // 优先在句末翻页，句子较长时让紧邻的标点随上一页显示。
        for (let cut = end; cut >= start + 54; cut -= 1) {
          if (sentenceEnd.test(characters[cut - 1])) {
            end = cut;
            break;
          }
        }
        while (end < characters.length && end < start + charactersPerPage + 4 && closingPunctuation.test(characters[end])) {
          end += 1;
        }
      }
      pages.push(characters.slice(start, end).join(''));
      start = end;
    }
  }
  return pages;
}

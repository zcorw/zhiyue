const byId = (id) => document.getElementById(id);
const library = byId('library');
const reader = byId('reader');
const libraryStatus = byId('library-status');
const articleList = byId('article-list');
const readerTitle = byId('reader-title');
const readerDate = byId('reader-date');
const readerText = byId('reader-text');
const previousPage = byId('previous-page');
const nextPage = byId('next-page');
const pageIndicator = byId('page-indicator');
const audioToggle = byId('audio-toggle');
const audioIcon = byId('audio-icon');
const audioLabel = byId('audio-label');
const audioStatus = byId('audio-status');
const media = byId('media');

let articles = [];
let entries = [];
let selection = 0;
let currentArticle = null;
let page = 0;
let activeAudio = null;

function makeElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}

function showDate(element, publishedAt) {
  element.dateTime = publishedAt;
  element.textContent = publishedAt.slice(0, 10);
}

function renderLibrary() {
  entries = articles.map((article, index) => {
    const row = document.createElement('li');
    const entry = makeElement('button', 'article-entry', '');
    entry.type = 'button';
    entry.addEventListener('focus', () => selectEntry(index));
    entry.addEventListener('click', () => openArticle(index));

    const copy = makeElement('span', 'entry-copy', '');
    copy.append(
      makeElement('span', 'entry-title', article.title),
      makeElement('span', 'entry-summary', article.summary),
    );

    const meta = makeElement('span', 'entry-meta', '');
    const date = document.createElement('time');
    showDate(date, article.publishedAt);
    meta.append(date, makeElement('span', article.audio ? 'entry-audio' : '', article.audio ? '有音频' : '纯文字'));

    entry.append(copy, meta);
    row.append(entry);
    articleList.append(row);
    return entry;
  });

  byId('article-count').textContent = `${articles.length} 篇`;
  libraryStatus.hidden = entries.length > 0;
  libraryStatus.textContent = entries.length ? '' : '暂无文章';
  selectEntry(0);
}

function selectEntry(index) {
  entries[selection]?.classList.remove('selected');
  selection = index;
  entries[selection]?.classList.add('selected');
}

function openArticle(index) {
  if (!articles[index]) return;

  selectEntry(index);
  currentArticle = articles[index];
  page = 0;
  readerTitle.textContent = currentArticle.title;
  showDate(readerDate, currentArticle.publishedAt);
  renderPage();
  prepareAudio(currentArticle.audio);

  library.hidden = true;
  reader.hidden = false;
  readerTitle.focus();
}

function closeArticle() {
  if (!currentArticle) return;

  disposeAudio();
  currentArticle = null;
  reader.hidden = true;
  library.hidden = false;
  entries[selection]?.focus();
}

function renderPage() {
  const totalPages = currentArticle.paragraphs.length;
  readerText.textContent = totalPages ? currentArticle.paragraphs[page] : '暂无正文';
  pageIndicator.textContent = totalPages ? `${page + 1} / ${totalPages}` : '0 / 0';
  previousPage.disabled = page === 0;
  nextPage.disabled = page >= totalPages - 1;
}

function changePage(direction) {
  if (!currentArticle) return;

  const target = page + direction;
  if (target < 0 || target >= currentArticle.paragraphs.length) return;
  page = target;
  renderPage();
}

function updateAudio(label, status, playing = false) {
  audioLabel.textContent = label;
  audioStatus.textContent = status;
  audioIcon.textContent = playing ? 'Ⅱ' : '▶';
}

function showAudioError() {
  updateAudio('重试播放', '音频加载失败');
}

function prepareAudio(source) {
  disposeAudio();
  audioToggle.hidden = !source;
  updateAudio('播放音频', source ? '' : '此文无音频');
  if (!source) return;

  const audio = new Audio();
  audio.preload = 'none';
  activeAudio = audio;

  // 忽略已离开的文章所产生的播放器事件。
  const on = (event, handler) => audio.addEventListener(event, () => {
    if (activeAudio === audio) handler();
  });
  on('playing', () => {
    if (!audio.paused) updateAudio('暂停', '播放中', true);
  });
  on('waiting', () => {
    if (!audio.paused) updateAudio('暂停', '正在缓冲', true);
  });
  on('pause', () => {
    if (audio.paused && !audio.ended && !audio.error) updateAudio('继续播放', '已暂停');
  });
  on('ended', () => {
    if (audio.ended) updateAudio('重新播放', '播放完毕');
  });
  on('error', () => {
    if (audio.error) showAudioError();
  });

  audio.src = new URL(`../aiui${source}`, import.meta.url).href;
  media.append(audio);
}

function disposeAudio() {
  const audio = activeAudio;
  activeAudio = null;
  if (!audio) return;

  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.remove();
}

async function toggleAudio() {
  const audio = activeAudio;
  if (!audio) return;
  if (!audio.paused && !audio.ended) {
    audio.pause();
    return;
  }

  if (audio.error) audio.load();
  if (audio.ended) audio.currentTime = 0;
  updateAudio('暂停', '正在加载音频', true);
  try {
    await audio.play();
  } catch (error) {
    if (activeAudio === audio && error.name !== 'AbortError') showAudioError();
  }
}

byId('back').addEventListener('click', closeArticle);
previousPage.addEventListener('click', () => changePage(-1));
nextPage.addEventListener('click', () => changePage(1));
audioToggle.addEventListener('click', toggleAudio);
window.addEventListener('pagehide', () => activeAudio?.pause());

window.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;

  const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
  const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
  if (backward || forward) {
    const step = forward ? 1 : -1;
    event.preventDefault();
    if (currentArticle) {
      changePage(step);
    } else if (entries.length) {
      const target = Math.min(entries.length - 1, Math.max(0, selection + step));
      entries[target].focus();
    }
  } else if (currentArticle && (event.key === 'Escape' || event.key === 'Backspace')) {
    event.preventDefault();
    closeArticle();
  } else if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') {
    event.preventDefault();
    if (currentArticle) {
      toggleAudio();
    } else {
      openArticle(selection);
    }
  }
});

try {
  const content = await import('../aiui/data/articles.js');
  articles = [...content.articles].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  renderLibrary();
} catch {
  libraryStatus.textContent = '文章加载失败，请重新加载此页';
}

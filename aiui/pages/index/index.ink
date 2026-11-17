<script def>
{
  "navigationBarTitleText": "知阅"
}
</script>

<script setup>
import wx from 'wx';
import { articles } from '../../data/articles.js';
import { getArticleIndex, getLibraryView, rowsPerScreen } from '../../lib/reading.js';
import { searchDemo, categoryPage } from '../../lib/search.js';
import { createSpeechInput } from '../../lib/speech.js';
import { createTiltFocus } from '../../lib/tilt-focus.js';
import { articlePageSize, cancelTimer, createRequest, recoveryDelay, watchBindingExpiry, zhisheng } from '../../lib/zhisheng.js';

export default {
  data: {
    selectedIndex: 0,
    selectedId: '',
    countLabel: '',
    rows: [],
    message: '',
    live: false,
    bound: false,
    accountSelected: false,
    canPair: false,
    canRetry: false,
    loading: false,
    searchSelected: false,
    voiceState: 'idle',
    searchActive: false,
    categoriesActive: false,
    heading: '全部文章',
    screenStart: 0,
    screenEnd: 0,
    listPageLabel: '0 / 0',
    canPreviousListPage: false,
    canNextListPage: false,
    pageFocus: '',
    tiltAvailable: false,
  },

  onLoad() {
    this.opening = false;
    this.visible = false;
    this.showVersion = 0;
    this.request = null;
    this.libraryPage = null;
    this.binding = null;
    this.retryIndex = 0;
    this.resumeSelection = null;
    this.retrySelection = null;
    this.recoveryAttempts = 0;
    this.searchFilter = null;
    this.searchQuery = '';
    this.searchNoMatch = false;
    this.demoResults = null;
    this.speech = createSpeechInput({
      onState: (voiceState, message) => this.setData({ voiceState, message }),
      onText: (text) => this.search(text),
    });
    this.tilt = createTiltFocus({ onFocus: (direction) => this.focusListPage(direction),
      onAvailable: (tiltAvailable) => this.setData({ tiltAvailable }) });
    if (zhisheng.mode === 'demo') this.setData(getLibraryView(0));
    else this.setData({ live: true });
  },

  async onShow() {
    this.visible = true;
    this.tilt.start();
    const showVersion = ++this.showVersion;
    if (zhisheng.mode === 'demo') return;
    if (zhisheng.mode !== 'live') {
      this.clearLibrary('知声地址配置无效。', false);
      return;
    }
    try {
      if (!zhisheng.storageReady) {
        this.setData({ message: '正在读取账号信息…', canPair: false, loading: true });
        await zhisheng.ready();
        if (!this.visible || this.showVersion !== showVersion) return;
      }
      const binding = zhisheng.getBinding();
      if (!binding) {
        this.clearLibrary('绑定知声后可查看授权文章。');
        return;
      }
      const sameBinding = binding.bindingId === this.binding?.bindingId && binding.account.id === this.binding?.account.id;
      if (sameBinding && this.request) return;
      if (sameBinding) this.rememberSelection();
      else { this.resumeSelection = null; this.resetSearch(); }
      this.cancelRequest();
      this.hideArticles();
      this.binding = binding;
      this.watchAuthorization(binding);
      this.setData({ bound: true, canPair: true });
      this.loadLibrary(this.resumeSelection?.index ?? 0, this.resumeSelection);
    } catch {
      if (!this.visible || this.showVersion !== showVersion) return;
      this.clearLibrary('无法读取眼镜上的账号信息。', false);
    }
  },

  onHide() {
    this.visible = false;
    this.tilt.stop();
    this.showVersion += 1;
    this.speech.cancel();
    if (this.data.voiceState !== 'idle') this.setData({ message: '' });
    this.setData({ voiceState: 'idle' });
    if (zhisheng.mode === 'live') {
      this.rememberSelection();
      this.hideArticles();
    }
    this.cancelRequest();
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
  },

  onUnload() {
    this.onHide();
    this.libraryPage = null;
    this.binding = null;
    this.resumeSelection = null;
    this.retrySelection = null;
  },

  onHostFocus() { if (this.visible) this.tilt.start(); },
  onHostBlur() { this.tilt.stop(); },

  rememberSelection() {
    if (!this.libraryPage) return;
    this.resumeSelection = {
      index: this.data.selectedIndex,
      id: this.data.selectedId,
      accountSelected: this.data.accountSelected,
      pageFocus: this.data.pageFocus,
    };
  },

  hideArticles() {
    this.libraryPage = null;
    this.setData({ ...getLibraryView(0, { items: [] }), countLabel: '', accountSelected: false, canRetry: false });
  },

  cancelRequest() {
    cancelTimer(this.recoveryTimer);
    this.recoveryTimer = null;
    const request = this.request;
    this.request = null;
    request?.cancel();
    if (request) this.setData({ loading: false });
  },

  clearLibrary(message, canPair = true) {
    this.speech.cancel();
    this.resetSearch();
    this.cancelRequest();
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
    this.libraryPage = null;
    this.binding = null;
    this.resumeSelection = null;
    this.retrySelection = null;
    this.setData({ ...getLibraryView(0, { items: [] }), bound: false, accountSelected: false,
      canPair, canRetry: false, loading: false, message });
  },

  expireBinding() {
    try { zhisheng.getBinding(); } catch { /* 阅读界面仍然清除 */ }
    this.clearLibrary('授权已失效，请重新绑定。');
  },

  watchAuthorization(binding) {
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
    if ((binding.refreshToken || binding.upgradePending) && binding.expiresAt <= Date.now()) return;
    this.expiryTimer = watchBindingExpiry(binding, () => {
      let current;
      try { current = zhisheng.getBinding(); } catch { this.onShow(); return; }
      if (current?.refreshToken || current?.upgradePending) this.onShow();
      else this.expireBinding();
    });
  },

  async loadLibrary(index, selection = null) {
    if (this.request || !this.binding) return;
    cancelTimer(this.recoveryTimer);
    this.recoveryTimer = null;
    const request = createRequest();
    this.request = request;
    this.retryIndex = index;
    this.retrySelection = selection;
    this.setData({ loading: true, canRetry: false, message: '正在加载文章…' });
    try {
      const offset = Math.floor(index / articlePageSize) * articlePageSize;
      let page;
      if (this.data.categoriesActive) {
        const library = await zhisheng.listArticles(0, request.signal);
        page = categoryPage(library.navigation);
      } else if (this.searchNoMatch) {
        await zhisheng.ensureBinding();
        page = { items: [], total: 0, offset: 0 };
      } else page = await zhisheng.listArticles(offset, request.signal, this.searchFilter ?? {});
      if (this.request !== request) return;
      if (!this.data.categoriesActive && page.total && page.total <= offset) {
        index = page.total - 1;
        page = await zhisheng.listArticles(Math.floor(index / articlePageSize) * articlePageSize, request.signal, this.searchFilter ?? {});
      }
      if (this.request !== request) return;
      if (page.total && !page.items.length) throw new Error('library_changed');
      if (selection?.id) {
        const position = page.items.findIndex((item) => item.id === selection.id);
        if (position >= 0) index = page.offset + position;
      }
      this.libraryPage = page;
      this.recoveryAttempts = 0;
      this.binding = zhisheng.getBinding();
      if (this.binding) this.watchAuthorization(this.binding);
      this.resumeSelection = null;
      this.retrySelection = null;
      this.setData({ ...this.listView(index, page), message: this.data.categoriesActive && !page.total ? '暂无可用分类，可重新检索或返回全部文章' : '',
        accountSelected: selection?.accountSelected ?? this.data.accountSelected, pageFocus: selection?.pageFocus ?? '' });
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === 'auth_required') this.expireBinding();
      else {
        this.setData({ message: '文章加载失败 · 单击重试', canRetry: true });
        const delay = recoveryDelay(error, this.recoveryAttempts++);
        if (delay !== null) this.recoveryTimer = setTimeout(() => this.retry(), delay);
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        this.setData({ loading: false });
      }
    }
  },

  retry() {
    if (this.data.canRetry) {
      if (this.searchQuery) this.search(this.searchQuery);
      else this.loadLibrary(this.retryIndex, this.retrySelection);
    }
  },

  resetSearch() {
    this.speech?.cancel();
    this.searchFilter = null;
    this.searchQuery = '';
    this.searchNoMatch = false;
    this.demoResults = null;
    this.setData({ heading: '全部文章', searchActive: false, categoriesActive: false, searchSelected: false, voiceState: 'idle', pageFocus: '' });
  },

  voiceSearch() {
    if (this.data.live && !this.data.bound) return;
    if (this.data.voiceState === 'listening') { this.speech.stop(); return; }
    if (this.data.voiceState === 'recognizing') return;
    this.cancelRequest();
    this.setData({ searchSelected: true, accountSelected: false, pageFocus: '' });
    this.speech.start();
  },

  async search(text) {
    this.cancelRequest();
    this.searchQuery = text;
    this.hideArticles();
    const request = createRequest();
    this.request = request;
    // 等待检索或分类导航时也提供返回入口，失败后仍可退出检索。
    this.setData({ loading: true, canRetry: false, searchActive: true, message: '正在检索…' });
    let openId = '';
    try {
      let result = this.data.live ? await zhisheng.searchArticles(text, request.signal) : searchDemo(articles, text);
      if (this.request !== request) return;
      if (this.data.live && result.kind === 'category' && result.noMatch) {
        const library = await zhisheng.listArticles(0, request.signal);
        if (this.request !== request) return;
        result = categoryPage(library.navigation);
      }
      this.setData({ categoriesActive: result.kind === 'categories' });
      this.searchFilter = result.filters;
      this.searchNoMatch = Boolean(result.noMatch);
      this.searchQuery = '';
      this.libraryPage = result;
      if (this.data.live) {
        this.binding = zhisheng.getBinding();
        if (this.binding) this.watchAuthorization(this.binding);
      }
      if (!this.data.live) this.demoResults = result.items;
      this.setData({ ...this.listView(0, result), heading: result.label, searchActive: result.kind !== 'all',
        searchSelected: false, accountSelected: false,
        message: result.kind === 'categories' ? (result.total ? '未找到指定分类，请选择分类' : '暂无可用分类，可重新检索或返回全部文章') : result.total ? (result.resolvedBy === 'fallback' ? '语义服务暂不可用 · 已使用基础检索' : '') : '没有找到，可重新检索或返回全部' });
      if (result.kind === 'article' && result.total === 1) openId = result.items[0].id;
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === 'auth_required') this.expireBinding();
      else this.setData({ canRetry: true, message: error.code === 'not_found'
        ? '知声服务需更新后才能语音检索' : '检索失败 · 单击重试' });
    } finally {
      if (this.request === request) { this.request = null; this.setData({ loading: false }); }
    }
    if (openId) this.openArticle(openId);
  },

  showAll() {
    this.speech.cancel();
    this.cancelRequest();
    this.resetSearch();
    if (this.data.live) this.loadLibrary(0);
    else { this.libraryPage = null; this.setData({ ...getLibraryView(0), message: '', canRetry: false }); }
  },

  listView(index, page) {
    const view = getLibraryView(index, page);
    if (this.data.categoriesActive) {
      view.countLabel = page.total ? view.countLabel : '0 个分类';
      view.rows = view.rows.map((row) => ({ ...row,
        audioLabel: page.items.find((item) => item.id === row.id).categoryCount + ' 篇文章' }));
    }
    return view;
  },

  select(index) {
    if (this.data.loading || !this.data.rows.length) return;
    const target = Math.min(Math.max(this.data.screenStart, index), this.data.screenEnd - 1);
    this.setData({ ...this.listView(target, this.libraryPage ?? undefined), message: '', canRetry: false,
      accountSelected: false, searchSelected: false });
  },

  focusListPage(direction) {
    if (!['previous', 'next'].includes(direction) || !this.data.rows.length || this.data.loading || this.data.voiceState !== 'idle'
        || (this.data.live && !this.data.bound)) return;
    this.setData({ pageFocus: direction, accountSelected: false, searchSelected: false });
  },

  previousListPage() { this.changeListPage(-1); },
  nextListPage() { this.changeListPage(1); },

  changeListPage(change) {
    if (this.data.loading || this.data.voiceState !== 'idle' || this.request) return;
    if (change < 0 ? !this.data.canPreviousListPage : !this.data.canNextListPage) return;
    const target = this.data.screenStart + change * rowsPerScreen;
    const pageFocus = change < 0 ? 'previous' : 'next';
    const page = this.libraryPage;
    if (this.data.live && !this.data.categoriesActive
        && (!page || target < page.offset || target >= page.offset + page.items.length)) {
      this.loadLibrary(target, { pageFocus });
    } else {
      this.setData({ ...this.listView(target, page ?? undefined), pageFocus, message: '', canRetry: false,
        searchSelected: false, accountSelected: false });
    }
  },

  moveLibraryFocus(change) {
    if (this.data.loading) return;
    if (this.data.pageFocus) {
      if (change < 0) {
        if (this.data.pageFocus === 'next' && this.data.canPreviousListPage) this.focusListPage('previous');
        else this.select(this.data.screenEnd - 1);
      } else if (this.data.canNextListPage) this.focusListPage('next');
    } else if (this.data.searchSelected) {
      if (change > 0) {
        this.setData({ searchSelected: false, accountSelected: this.data.live && this.data.bound });
      }
    } else if (this.data.accountSelected) {
      this.setData(change < 0 ? { accountSelected: false, searchSelected: true } : { accountSelected: false });
    } else if (change < 0 && this.data.selectedIndex === this.data.screenStart) {
      if (!this.data.live || this.data.bound) this.setData({ accountSelected: this.data.live, searchSelected: !this.data.live });
    } else if (change > 0 && this.data.selectedIndex === this.data.screenEnd - 1) {
      if (this.data.canPreviousListPage) this.focusListPage('previous');
      else if (this.data.canNextListPage) this.focusListPage('next');
    } else this.select(this.data.selectedIndex + change);
  },

  onKeyUp(event) {
    if (this.data.voiceState !== 'idle') {
      if (event.code === 'Enter') { event.preventDefault(); this.speech.stop(); }
      else if (event.code === 'Escape' || event.code === 'Backspace') {
        event.preventDefault(); this.speech.cancel(); this.setData({ voiceState: 'idle', message: '已取消语音检索' });
      }
      return;
    }
    if ((event.code === 'Escape' || event.code === 'Backspace') && this.data.searchActive) {
      event.preventDefault(); this.showAll(); return;
    }
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      this.moveLibraryFocus(event.code === 'ArrowUp' ? -1 : 1);
    } else if (event.code === 'Enter') {
      if (this.data.pageFocus) {
        event.preventDefault(); this.changeListPage(this.data.pageFocus === 'previous' ? -1 : 1);
      } else if (this.data.searchSelected) {
        event.preventDefault(); this.voiceSearch();
      } else if (this.data.accountSelected || (!this.data.bound && this.data.canPair)) {
        event.preventDefault();
        this.openAccount();
      } else if (this.data.canRetry) {
        event.preventDefault();
        this.retry();
      } else if (this.data.selectedId && !this.data.loading) {
        event.preventDefault();
        this.openArticle(this.data.selectedId);
      }
    }
  },

  tapArticle(event) {
    const id = event.currentTarget?.dataset?.id ?? event.target?.dataset?.id;
    this.openArticle(id);
  },

  openArticle(id) {
    const page = this.libraryPage;
    if (this.data.loading || !this.data.rows.some((row) => row.id === id)) return;
    if (this.data.categoriesActive) {
      const category = page?.items.find((item) => item.id === id);
      if (!category) return;
      this.hideArticles();
      this.setData({ categoriesActive: false, heading: category.title, searchSelected: false,
        accountSelected: false, message: '', rows: [], selectedId: '' });
      this.searchFilter = { q: '', category: id };
      this.searchNoMatch = false;
      this.resumeSelection = null;
      if (this.data.live) this.loadLibrary(0);
      else {
        this.demoResults = articles.filter((item) => (item.category?.id ?? 'uncategorized') === id);
        this.libraryPage = { items: this.demoResults, total: this.demoResults.length, offset: 0 };
        this.setData(getLibraryView(0, this.libraryPage));
      }
      return;
    }
    const liveIndex = page?.items.findIndex((item) => item.id === id) ?? -1;
    const index = this.data.live || this.demoResults ? liveIndex < 0 ? -1 : page.offset + liveIndex : getArticleIndex(id);
    if (index < 0 || this.opening) return;
    this.setData({ ...getLibraryView(index, page ?? undefined), message: '', accountSelected: false, searchSelected: false, canRetry: false });
    this.navigate(`/pages/reader/index?id=${encodeURIComponent(id)}`);
  },

  openAccount() {
    if (this.data.canPair) this.navigate('/pages/pair/index');
  },

  navigate(url) {
    if (this.opening) return;
    this.opening = true;
    wx.navigateTo({
      url,
      fail: () => this.setData({ message: '无法打开，请重试' }),
      complete: () => { this.opening = false; },
    });
  },
};
</script>

<page>
  <view class="screen">
    <view class="header">
      <text class="heading">{{heading}}</text>
      <view class="header-actions">
        <text class="meta" ink:if="{{!live || bound}}">{{countLabel}}</text>
        <button class="account {{searchSelected ? 'selected' : ''}}" ink:if="{{!live || bound}}" bindtap="voiceSearch">{{voiceState === 'listening' ? '结束识别' : voiceState === 'recognizing' ? '识别中' : '语音检索'}}</button>
        <button class="account" ink:if="{{searchActive}}" bindtap="showAll">全部</button>
        <button class="account {{accountSelected ? 'selected' : ''}}" ink:if="{{bound}}" bindtap="openAccount">账号</button>
      </view>
    </view>
    <view class="library">
      <view class="row {{item.selected && !accountSelected && !searchSelected && !pageFocus ? 'selected' : ''}}" ink:for="{{rows}}" ink:key="id" data-id="{{item.id}}" bindtap="tapArticle">
        <text class="title" data-id="{{item.id}}">{{item.title}}</text>
        <text class="row-meta" data-id="{{item.id}}">{{categoriesActive ? '' : item.date + ' · '}}{{item.audioLabel}}</text>
      </view>
      <text class="empty" ink:if="{{!rows.length && (!live || (bound && !message))}}">暂无文章</text>
      <button class="account bind" ink:if="{{live && !bound && canPair}}" bindtap="openAccount">绑定知声</button>
    </view>
    <view class="footer">
      <view class="pagination" ink:if="{{!live || bound}}">
        <button class="account {{pageFocus === 'previous' ? 'selected' : ''}}" disabled="{{!canPreviousListPage || loading}}" bindtap="previousListPage">上一页</button>
        <text class="meta">{{listPageLabel}}</text>
        <button class="account {{pageFocus === 'next' ? 'selected' : ''}}" disabled="{{!canNextListPage || loading}}" bindtap="nextListPage">下一页</button>
      </view>
      <text class="meta" ink:if="{{message}}" bindtap="retry">{{message}}</text>
      <text class="meta" ink:elif="{{pageFocus}}">单击{{pageFocus === 'previous' ? '上一页' : '下一页'}} · 滑动切换焦点</text>
      <text class="meta" ink:elif="{{accountSelected}}">单击管理账号 · 向下返回文章</text>
      <text class="meta" ink:elif="{{searchSelected}}">单击开始语音检索 · 向下返回</text>
      <text class="meta" ink:else>滑动选择 · 单击打开 · 向上选择语音</text>
    </view>
  </view>
</page>

<style>
.screen {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 14px 24px;
  background-color: #000000;
  font-family: sans-serif;
}
.header, .footer {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 6px 0;
}
.header { border-bottom: 1px solid rgba(64,255,94,0.30); }
.footer { border-top: 1px solid rgba(64,255,94,0.30); flex-direction: column; align-items: stretch; gap: 4px; }
.pagination { display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.heading { flex: 1; min-width: 0; color: #40ff5e; font-size: 22px; font-weight: 600; line-height: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta, .row-meta { color: rgba(64,255,94,0.65); font-size: 14px; line-height: 20px; }
.header-actions { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.account { padding: 4px 8px; color: #40ff5e; font-size: 14px; line-height: 18px; background-color: #000000; border: 1px solid rgba(64,255,94,0.38); border-radius: 4px; }
.account.selected { border-width: 2px; border-color: #40ff5e; }
.account:disabled { color: rgba(64,255,94,0.35); }
.bind { width: 100%; }
.library {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
}
.row {
  display: flex;
  flex-direction: column;
  padding: 6px 12px;
  border-left: 2px solid rgba(64,255,94,0.22);
}
.row.selected, .row:focus, .row:active {
  border-left-width: 4px;
  border-left-color: #40ff5e;
  background-color: rgba(64,255,94,0.12);
}
.title {
  width: 100%;
  color: rgba(64,255,94,0.83);
  font-size: 18px;
  line-height: 24px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.selected .title { color: #40ff5e; }
.empty { color: rgba(64,255,94,0.83); font-size: 18px; }
</style>

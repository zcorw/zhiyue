<script def>
{
  "navigationBarTitleText": "知阅"
}
</script>

<script setup>
import wx from 'wx';
import { getArticleIndex, getLibraryView } from '../../lib/reading.js';
import { articlePageSize, cancelTimer, createRequest, watchBindingExpiry, zhisheng } from '../../lib/zhisheng.js';

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
  },

  onLoad() {
    this.opening = false;
    this.request = null;
    this.libraryPage = null;
    this.binding = null;
    this.retryIndex = 0;
    this.resumeSelection = null;
    this.retrySelection = null;
    if (zhisheng.mode === 'demo') this.setData(getLibraryView(0));
    else this.setData({ live: true });
  },

  onShow() {
    if (zhisheng.mode === 'demo') return;
    if (zhisheng.mode !== 'live') {
      this.clearLibrary('知声地址配置无效。', false);
      return;
    }
    try {
      const binding = zhisheng.getBinding();
      if (!binding) {
        this.clearLibrary('绑定知声后可查看授权文章。');
        return;
      }
      const sameBinding = binding.bindingId === this.binding?.bindingId && binding.account.id === this.binding?.account.id;
      if (sameBinding && this.request) return;
      if (sameBinding) this.rememberSelection();
      else this.resumeSelection = null;
      this.cancelRequest();
      this.hideArticles();
      this.binding = binding;
      cancelTimer(this.expiryTimer);
      this.expiryTimer = watchBindingExpiry(binding, () => this.onShow());
      this.setData({ bound: true, canPair: true });
      this.loadLibrary(this.resumeSelection?.index ?? 0, this.resumeSelection);
    } catch {
      this.clearLibrary('无法读取眼镜上的账号信息。', false);
    }
  },

  onHide() {
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

  rememberSelection() {
    if (!this.libraryPage) return;
    this.resumeSelection = {
      index: this.data.selectedIndex,
      id: this.data.selectedId,
      accountSelected: this.data.accountSelected,
    };
  },

  hideArticles() {
    this.libraryPage = null;
    this.setData({ rows: [], selectedIndex: 0, selectedId: '', countLabel: '', accountSelected: false, canRetry: false });
  },

  cancelRequest() {
    const request = this.request;
    this.request = null;
    request?.cancel();
    if (request) this.setData({ loading: false });
  },

  clearLibrary(message, canPair = true) {
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

  async loadLibrary(index, selection = null) {
    if (this.request || !this.binding) return;
    const request = createRequest();
    this.request = request;
    this.retryIndex = index;
    this.retrySelection = selection;
    this.setData({ loading: true, canRetry: false, message: '正在加载文章…' });
    try {
      const offset = Math.floor(index / articlePageSize) * articlePageSize;
      let page = await zhisheng.listArticles(offset, request.signal);
      if (this.request !== request) return;
      if (page.total && page.total <= offset) {
        index = page.total - 1;
        page = await zhisheng.listArticles(Math.floor(index / articlePageSize) * articlePageSize, request.signal);
      }
      if (this.request !== request) return;
      if (page.total && !page.items.length) throw new Error('library_changed');
      if (selection?.id) {
        const position = page.items.findIndex((item) => item.id === selection.id);
        if (position >= 0) index = page.offset + position;
      }
      this.binding = zhisheng.getBinding();
      cancelTimer(this.expiryTimer);
      this.expiryTimer = watchBindingExpiry(this.binding, () => this.onShow());
      this.libraryPage = page;
      this.resumeSelection = null;
      this.retrySelection = null;
      this.setData({ ...getLibraryView(index, page), message: '',
        accountSelected: selection?.accountSelected ?? this.data.accountSelected });
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === 'auth_required') this.expireBinding();
      else {
        this.setData({ message: '文章加载失败 · 单击重试', canRetry: true });
        cancelTimer(this.expiryTimer);
        this.expiryTimer = setTimeout(() => this.onShow(), 30000);
      }
    } finally {
      if (this.request === request) {
        this.request = null;
        this.setData({ loading: false });
      }
    }
  },

  retry() {
    if (this.data.canRetry) this.loadLibrary(this.retryIndex, this.retrySelection);
  },

  select(index) {
    const page = this.libraryPage;
    if (!this.data.live) {
      this.setData({ ...getLibraryView(index), message: '' });
      return;
    }
    if (!page || this.request) return;
    const target = Math.min(Math.max(0, index), Math.max(0, page.total - 1));
    if (page.total && (target < page.offset || target >= page.offset + page.items.length)) {
      this.loadLibrary(target);
      return;
    }
    this.setData({ ...getLibraryView(target, page), message: '', canRetry: false });
  },

  onKeyUp(event) {
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.preventDefault();
      const change = event.code === 'ArrowUp' ? -1 : 1;
      if (this.data.live && this.data.bound && this.data.selectedIndex === 0 && change < 0) {
        this.setData({ accountSelected: true });
      } else if (this.data.accountSelected) {
        if (change > 0) this.setData({ accountSelected: false });
      } else {
        this.select(this.data.selectedIndex + change);
      }
    } else if (event.code === 'Enter') {
      if (this.data.accountSelected || (!this.data.bound && this.data.canPair)) {
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
    const liveIndex = page?.items.findIndex((item) => item.id === id) ?? -1;
    const index = this.data.live ? liveIndex < 0 ? -1 : page.offset + liveIndex : getArticleIndex(id);
    if (index < 0 || this.opening) return;
    this.setData({ ...getLibraryView(index, page ?? undefined), message: '', accountSelected: false, canRetry: false });
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
      <text class="heading">全部文章</text>
      <view class="header-actions">
        <text class="meta" ink:if="{{!live || bound}}">{{countLabel}}</text>
        <button class="account {{accountSelected ? 'selected' : ''}}" ink:if="{{bound}}" bindtap="openAccount">账号</button>
      </view>
    </view>
    <view class="library">
      <view class="row {{item.selected && !accountSelected ? 'selected' : ''}}" ink:for="{{rows}}" ink:key="id" data-id="{{item.id}}" bindtap="tapArticle">
        <text class="title" data-id="{{item.id}}">{{item.title}}</text>
        <text class="row-meta" data-id="{{item.id}}">{{item.date}} · {{item.audioLabel}}</text>
      </view>
      <text class="empty" ink:if="{{!rows.length && (!live || (bound && !message))}}">暂无文章</text>
      <button class="account bind" ink:if="{{live && !bound && canPair}}" bindtap="openAccount">绑定知声</button>
    </view>
    <view class="footer">
      <text class="meta" ink:if="{{message}}" bindtap="retry">{{message}}</text>
      <text class="meta" ink:elif="{{accountSelected}}">单击管理账号 · 向下返回文章</text>
      <text class="meta" ink:else>滑动选择 · 单击打开</text>
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
.footer { border-top: 1px solid rgba(64,255,94,0.30); }
.heading { color: #40ff5e; font-size: 22px; font-weight: 600; line-height: 28px; }
.meta, .row-meta { color: rgba(64,255,94,0.65); font-size: 14px; line-height: 20px; }
.header-actions { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.account { padding: 4px 8px; color: #40ff5e; font-size: 14px; line-height: 18px; background-color: #000000; border: 1px solid rgba(64,255,94,0.38); border-radius: 4px; }
.account.selected { border-width: 2px; border-color: #40ff5e; }
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

<script def>
{
  "navigationBarTitleText": "阅读"
}
</script>

<script setup>
import wx from 'wx';
import { getArticle, layoutText, pageAtOffset } from '../../lib/reading.js';
import { readTextLayout } from '../../lib/text-layout.js';
import { createTiltFocus } from '../../lib/tilt-focus.js';
import { createAudioController } from '../../lib/audio.js';
import { cancelTimer, createRequest, recoveryDelay, watchBindingExpiry, zhisheng } from '../../lib/zhisheng.js';

const playbackLabel = {
  idle: '播放音频',
  loading: '载入中 · 取消',
  playing: '暂停',
  paused: '继续播放',
  ended: '重播',
  error: '播放失败 · 重试',
};

export default {
  data: {
    title: '',
    hasBody: false,
    body: '',
    bodyLines: [],
    readingAreaStyle: '',
    pageLabel: '',
    pageIndex: 0,
    hasAudio: false,
    audioLabel: '',
    canGoBack: false,
    canGoForward: false,
    canRetry: false,
    pageFocus: '',
    tiltAvailable: false,
  },

  onLoad(query = {}) {
    this.articleId = query.id;
    this.leaving = false;
    this.visible = false;
    this.showVersion = 0;
    this.request = null;
    this.player = null;
    this.pages = [];
    this.linesByPage = [];
    this.bindingId = null;
    this.releaseId = null;
    this.resumePosition = null;
    this.recoveryAttempts = 0;
    this.layoutReady = false;
    this.paragraphs = null;
    this.pendingOffset = 0;
    this.tilt = createTiltFocus({ onFocus: (direction) => this.focusPage(direction),
      onAvailable: (tiltAvailable) => this.setData({ tiltAvailable }) });
    if (zhisheng.mode === 'demo') this.showArticle(getArticle(this.articleId));
  },

  onReady() {
    this.layoutReady = true;
    this.reflowArticle();
  },

  async onShow() {
    this.visible = true;
    this.tilt.start();
    const showVersion = ++this.showVersion;
    if (zhisheng.mode === 'demo') { this.reflowArticle(); return; }
    if (zhisheng.mode !== 'live') {
      this.showMessage('知声地址配置无效。');
      return;
    }
    if (!this.articleId) {
      this.showMessage('这篇文章已不可用。');
      return;
    }
    try {
      if (!zhisheng.storageReady) {
        this.showMessage('正在读取账号信息…');
        await zhisheng.ready();
        if (!this.visible || this.showVersion !== showVersion) return;
      }
      const binding = zhisheng.getBinding();
      if (!binding) {
        this.expireBinding();
        return;
      }
      const sameBinding = this.bindingId === binding.bindingId;
      if (sameBinding && this.request) return;
      if (sameBinding) this.rememberPosition();
      else this.resumePosition = null;
      this.cancelLoad();
      this.bindingId = binding.bindingId;
      this.watchAuthorization(binding);
      this.loadArticle();
    } catch {
      if (!this.visible || this.showVersion !== showVersion) return;
      this.showMessage('无法读取眼镜上的账号信息。');
    }
  },

  async loadArticle() {
    if (this.request || !this.articleId) return;
    cancelTimer(this.recoveryTimer);
    this.recoveryTimer = null;
    const request = createRequest();
    this.request = request;
    this.showMessage('正在加载文章…');
    try {
      const article = await zhisheng.getArticle(this.articleId, request.signal);
      if (this.request === request) {
        this.recoveryAttempts = 0;
        const binding = zhisheng.getBinding();
        if (binding) this.watchAuthorization(binding);
        this.showArticle(article);
      }
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === 'auth_required') this.expireBinding();
      else if (error.code === 'not_found' || error.code === 'forbidden') this.showMessage('这篇文章已不可用。');
      else {
        this.showMessage('文章加载失败。', true);
        const delay = recoveryDelay(error, this.recoveryAttempts++);
        if (delay !== null) this.recoveryTimer = setTimeout(() => this.loadArticle(), delay);
      }
    } finally {
      if (this.request === request) this.request = null;
    }
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

  showArticle(article) {
    this.cancelLayout();
    const position = this.resumePosition;
    this.pendingOffset = position && position.releaseId === article?.releaseId ? position.offset : 0;
    this.resumePosition = null;
    this.releaseId = article?.releaseId ?? null;
    this.pages = [];
    this.linesByPage = [];
    this.paragraphs = article?.paragraphs ?? null;
    const audio = zhisheng.mode === 'live' && article?.hasAudio
      ? (signal, isCancelled) => zhisheng.getAudioBuffer(article.releaseId, signal, isCancelled)
      : article?.audio;
    this.player = audio ? createAudioController(
      audio,
      (state) => this.setData({ audioLabel: playbackLabel[state] }),
      (error) => {
        if (error.code === 'auth_required') this.expireBinding();
        else if (error.code === 'audio_http') this.setData({ audioLabel: `音频 HTTP ${error.status} · 重试` });
        else if (error.code === 'audio_download') this.setData({ audioLabel: '音频下载失败 · 重试' });
        else if (error.code === 'audio_download_timeout') this.setData({ audioLabel: '音频下载超时 · 重试' });
        else if (error.code === 'audio_timeout' || error.code === 'audio_player') {
          if (zhisheng.mode === 'live') zhisheng.forgetAudio(article.releaseId);
          this.setData({ audioLabel: error.code === 'audio_timeout' ? '播放器加载超时 · 重试' : '播放器加载失败 · 重试' });
        }
        else this.setData({ audioLabel: '音频地址获取失败 · 重试' });
      },
    ) : null;
    this.setData({
      title: article?.title ?? '文章不可用',
      hasBody: Boolean(this.paragraphs?.join('\n')),
      hasAudio: Boolean(this.player),
      audioLabel: this.player ? playbackLabel.idle : '无音频',
      canRetry: false,
      body: article ? '正在排版…' : '这篇文章暂时无法阅读。', bodyLines: [], pageLabel: '',
      canGoBack: false, canGoForward: false,
    }, () => this.reflowArticle());
  },

  cancelLayout() {
    cancelTimer(this.layoutTimer);
    this.layoutTimer = null;
  },

  reflowArticle(attempt = 0) {
    this.cancelLayout();
    if (!this.layoutReady || !this.visible || !this.paragraphs) return;
    const offset = this.pages.length ? this.pages.slice(0, this.data.pageIndex).join('').length : this.pendingOffset;
    try {
      const options = readTextLayout(this);
      const layout = layoutText(this.paragraphs, options);
      this.pages = layout.map((page) => page.text);
      this.linesByPage = layout.map((page) => page.lines);
      this.layoutDiagnostic = { code: 'ready', width: options.width, height: options.height,
        geometry: options.geometrySource, measurement: options.measurementSource };
      this.setData({ readingAreaStyle: options.areaStyle, canRetry: false,
        pageFocus: this.data.pageFocus === 'retry' ? '' : this.data.pageFocus });
      this.showPage(pageAtOffset(this.pages, offset));
    } catch (error) {
      this.pages = [];
      this.linesByPage = [];
      this.pendingOffset = offset;
      const code = ['layout_area_unavailable', 'layout_measure_unavailable', 'layout_measure_failed'].includes(error.code)
        ? error.code : ['layout_too_narrow', 'layout_unavailable'].includes(error.message) ? error.message : 'layout_failed';
      this.layoutDiagnostic = { code };
      if (attempt < 2 && ['layout_area_unavailable', 'layout_measure_unavailable'].includes(code)) {
        this.setData({ body: '正在排版…', bodyLines: [], pageLabel: '', canGoBack: false, canGoForward: false, canRetry: false });
        const timer = setTimeout(() => {
          if (this.layoutTimer !== timer) return;
          this.layoutTimer = null;
          this.reflowArticle(attempt + 1);
        }, 100);
        this.layoutTimer = timer;
        return;
      }
      console.warn('Zhiyue reading layout:', code);
      this.setData({ body: '暂时无法排版，请重试。', bodyLines: [], pageLabel: '', canGoBack: false, canGoForward: false, canRetry: true, pageFocus: 'retry' });
    }
  },

  rememberPosition() {
    if (this.releaseId) this.resumePosition = { releaseId: this.releaseId,
      offset: this.pages.length ? this.pages.slice(0, this.data.pageIndex).join('').length : this.pendingOffset };
  },

  onHide() {
    this.visible = false;
    this.cancelLayout();
    this.tilt.stop();
    this.showVersion += 1;
    this.cancelLoad();
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (zhisheng.mode === 'live') {
      this.rememberPosition();
      this.showMessage('');
    } else {
      this.player?.stop();
    }
  },

  onUnload() {
    this.onHide();
    this.player = null;
    this.pages = [];
    this.linesByPage = [];
    this.paragraphs = null;
    this.bindingId = null;
    this.resumePosition = null;
  },

  cancelLoad() {
    cancelTimer(this.recoveryTimer);
    this.recoveryTimer = null;
    const request = this.request;
    this.request = null;
    request?.cancel();
  },

  onHostFocus() { if (this.visible) this.tilt.start(); },
  onHostBlur() { this.tilt.stop(); },

  focusPage(direction) {
    if (this.visible && this.pages.length && ['previous', 'next'].includes(direction)) {
      this.setData({ pageFocus: direction });
    }
  },

  moveReadingFocus(change) {
    if (!this.data.pageFocus && this.pages.length) { this.focusPage(change < 0 ? 'previous' : 'next'); return; }
    const controls = ['return', ...(this.data.canRetry ? ['retry'] : []),
      ...(this.pages.length ? ['previous', 'next'] : []), ...(this.player ? ['audio'] : [])];
    const index = Math.max(0, controls.indexOf(this.data.pageFocus));
    this.setData({ pageFocus: controls[Math.min(Math.max(0, index + change), controls.length - 1)] });
  },

  expireBinding() {
    try { zhisheng.getBinding(); } catch { /* 阅读界面仍然清除 */ }
    this.cancelLoad();
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
    this.bindingId = null;
    this.resumePosition = null;
    this.showMessage('授权已失效，请返回列表重新绑定。');
  },

  showMessage(body, canRetry = false) {
    this.cancelLayout();
    this.layoutDiagnostic = null;
    this.player?.stop();
    this.player = null;
    this.pages = [];
    this.linesByPage = [];
    this.paragraphs = null;
    this.releaseId = null;
    this.setData({ title: '阅读', pageLabel: '', pageIndex: 0, hasBody: false, hasAudio: false, audioLabel: '',
      canGoBack: false, canGoForward: false, body, bodyLines: [], canRetry, pageFocus: '' });
  },

  onKeyUp(event) {
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      this.moveReadingFocus(-1);
    } else if (event.code === 'ArrowDown') {
      event.preventDefault();
      this.moveReadingFocus(1);
    } else if (event.code === 'Enter' && this.data.pageFocus) {
      event.preventDefault();
      if (this.data.pageFocus === 'previous') this.previousPage();
      else if (this.data.pageFocus === 'next') this.nextPage();
      else if (this.data.pageFocus === 'audio') this.toggleAudio();
      else if (this.data.pageFocus === 'retry') this.retryReading();
      else if (this.data.pageFocus === 'return') this.returnToList();
    } else if (event.code === 'Enter' && this.data.canRetry) {
      event.preventDefault();
      this.retryReading();
    } else if (event.code === 'Enter' && this.player) {
      event.preventDefault();
      this.toggleAudio();
    } else if (event.code === 'Backspace' || event.code === 'Escape') {
      event.preventDefault();
      this.returnToList();
    }
  },

  showPage(requestedIndex) {
    const last = Math.max(0, this.pages.length - 1);
    const pageIndex = Math.min(Math.max(0, requestedIndex), last);
    this.setData({
      pageIndex,
      body: this.pages[pageIndex] ?? '这篇文章暂时无法阅读。',
      bodyLines: (this.linesByPage[pageIndex] ?? []).map((line, index) => ({ key: index, text: line || ' ' })),
      pageLabel: this.pages.length ? `${pageIndex + 1} / ${this.pages.length}` : '',
      canGoBack: pageIndex > 0,
      canGoForward: pageIndex < last,
    });
  },

  previousPage() {
    if (this.data.canGoBack) this.showPage(this.data.pageIndex - 1);
  },

  nextPage() {
    if (this.data.canGoForward) this.showPage(this.data.pageIndex + 1);
  },

  toggleAudio() {
    this.setData({ pageFocus: '' });
    this.player?.toggle();
  },

  retryReading() {
    if (this.paragraphs) this.reflowArticle();
    else this.loadArticle();
  },

  returnToList() {
    if (this.leaving) return;
    this.leaving = true;
    this.cancelLoad();
    this.player?.stop();
    wx.navigateBack({
      fail: () => wx.redirectTo({
        url: '/pages/index/index',
        fail: () => { this.leaving = false; },
      }),
    });
  },
};
</script>

<page>
  <view class="screen">
    <view class="header">
      <text class="title">{{title}}</text>
      <text class="meta">{{pageLabel}}</text>
    </view>
    <view id="reading-area" class="reading" style="{{readingAreaStyle}}">
      <text class="body" ink:if="{{!bodyLines.length}}">{{body}}</text>
      <text class="body line" ink:for="{{bodyLines}}" ink:key="key">{{item.text}}</text>
    </view>
    <view class="footer">
      <button class="control {{pageFocus === 'return' ? 'selected' : ''}}" bindtap="returnToList">返回</button>
      <button class="control {{pageFocus === 'retry' ? 'selected' : ''}}" ink:if="{{canRetry}}" bindtap="retryReading">重试</button>
      <view class="pagination" ink:if="{{hasBody}}">
        <button class="control {{pageFocus === 'previous' ? 'selected' : ''}} {{canGoBack ? '' : 'muted'}}" disabled="{{!canGoBack}}" bindtap="previousPage">上一页</button>
        <button class="control {{pageFocus === 'next' ? 'selected' : ''}} {{canGoForward ? '' : 'muted'}}" disabled="{{!canGoForward}}" bindtap="nextPage">下一页</button>
      </view>
      <button class="control audio {{pageFocus === 'audio' ? 'selected' : ''}}" ink:if="{{hasAudio}}" bindtap="toggleAudio">{{audioLabel}}</button>
      <text class="meta" ink:elif="{{hasBody}}">{{audioLabel}}</text>
    </view>
  </view>
  <canvas id="reading-measure" class="measure" width="1" height="1"></canvas>
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
  gap: 8px;
  padding: 6px 0;
}
.header { height: 42px; box-sizing: border-box; border-bottom: 1px solid rgba(64,255,94,0.30); }
.footer { height: 50px; box-sizing: border-box; border-top: 1px solid rgba(64,255,94,0.30); }
.title {
  width: 80%;
  color: #40ff5e;
  font-size: 22px;
  font-weight: 600;
  line-height: 28px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta { color: rgba(64,255,94,0.65); font-size: 14px; line-height: 20px; }
.reading { display: flex; flex-direction: column; flex: 1; min-height: 0; margin: 15px 0; overflow: hidden; }
.body { width: 100%; color: rgba(64,255,94,0.92); font-size: 20px; line-height: 30px; white-space: pre-wrap; }
.line { height: 30px; flex-shrink: 0; white-space: pre; }
.measure { position: fixed; width: 1px; height: 1px; top: 0; left: 0; opacity: 0; }
.pagination { display: flex; flex-direction: row; gap: 6px; }
.control {
  padding: 5px 8px;
  font-size: 14px;
  line-height: 20px;
  color: rgba(64,255,94,0.85);
  background-color: #000000;
  border: 2px solid rgba(64,255,94,0.38);
  border-radius: 4px;
}
.control:focus, .control:active { border-color: #40ff5e; background-color: rgba(64,255,94,0.12); }
.control.selected { border-width: 2px; border-color: #40ff5e; background-color: rgba(64,255,94,0.12); }
.control.muted { color: rgba(64,255,94,0.46); }
.control.audio { color: #40ff5e; }
</style>

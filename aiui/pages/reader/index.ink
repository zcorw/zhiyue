<script def>
{
  "navigationBarTitleText": "阅读"
}
</script>

<script setup>
import wx from 'wx';
import { getArticle, paginate } from '../../lib/reading.js';
import { createAudioController } from '../../lib/audio.js';
import { cancelTimer, createRequest, watchBindingExpiry, zhisheng } from '../../lib/zhisheng.js';

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
    pageLabel: '',
    pageIndex: 0,
    hasAudio: false,
    audioLabel: '',
    canGoBack: false,
    canGoForward: false,
    canRetry: false,
  },

  onLoad(query = {}) {
    this.articleId = query.id;
    this.leaving = false;
    this.request = null;
    this.player = null;
    this.pages = [];
    this.bindingToken = null;
    this.releaseId = null;
    this.resumePosition = null;
    if (zhisheng.mode === 'demo') this.showArticle(getArticle(this.articleId));
  },

  onShow() {
    if (zhisheng.mode === 'demo') return;
    if (zhisheng.mode !== 'live') {
      this.showMessage('知声地址配置无效。');
      return;
    }
    if (!this.articleId) {
      this.showMessage('这篇文章已不可用。');
      return;
    }
    try {
      const binding = zhisheng.getBinding();
      if (!binding) {
        this.expireBinding();
        return;
      }
      const sameBinding = this.bindingToken === binding.token;
      if (sameBinding && this.request) return;
      if (sameBinding) this.rememberPosition();
      else this.resumePosition = null;
      this.cancelLoad();
      this.bindingToken = binding.token;
      cancelTimer(this.expiryTimer);
      this.expiryTimer = watchBindingExpiry(binding, () => this.expireBinding());
      this.loadArticle();
    } catch {
      this.showMessage('无法读取眼镜上的账号信息。');
    }
  },

  async loadArticle() {
    if (this.request || !this.articleId) return;
    const request = createRequest();
    this.request = request;
    this.showMessage('正在加载文章…');
    try {
      const article = await zhisheng.getArticle(this.articleId, request.signal);
      if (this.request === request) this.showArticle(article);
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === 'auth_required') this.expireBinding();
      else if (error.code === 'not_found' || error.code === 'forbidden') this.showMessage('这篇文章已不可用。');
      else this.showMessage('文章加载失败。', true);
    } finally {
      if (this.request === request) this.request = null;
    }
  },

  showArticle(article) {
    const position = this.resumePosition;
    const pageIndex = position && position.releaseId === article?.releaseId ? position.pageIndex : 0;
    this.resumePosition = null;
    this.releaseId = article?.releaseId ?? null;
    this.pages = article ? paginate(article.paragraphs) : [];
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
      hasBody: this.pages.length > 0,
      hasAudio: Boolean(this.player),
      audioLabel: this.player ? playbackLabel.idle : '无音频',
      canRetry: false,
    });
    this.showPage(pageIndex);
  },

  rememberPosition() {
    if (this.releaseId) this.resumePosition = { releaseId: this.releaseId, pageIndex: this.data.pageIndex };
  },

  onHide() {
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
    this.bindingToken = null;
    this.resumePosition = null;
  },

  cancelLoad() {
    const request = this.request;
    this.request = null;
    request?.cancel();
  },

  expireBinding() {
    try { zhisheng.getBinding(); } catch { /* 阅读界面仍然清除 */ }
    this.cancelLoad();
    cancelTimer(this.expiryTimer);
    this.expiryTimer = null;
    this.bindingToken = null;
    this.resumePosition = null;
    this.showMessage('授权已失效，请返回列表重新绑定。');
  },

  showMessage(body, canRetry = false) {
    this.player?.stop();
    this.player = null;
    this.pages = [];
    this.releaseId = null;
    this.setData({ title: '阅读', pageLabel: '', pageIndex: 0, hasBody: false, hasAudio: false, audioLabel: '',
      canGoBack: false, canGoForward: false, body, canRetry });
  },

  onKeyUp(event) {
    if (event.code === 'ArrowUp' && this.data.hasBody) {
      event.preventDefault();
      this.previousPage();
    } else if (event.code === 'ArrowDown' && this.data.hasBody) {
      event.preventDefault();
      this.nextPage();
    } else if (event.code === 'Enter' && this.player) {
      event.preventDefault();
      this.toggleAudio();
    } else if (event.code === 'Enter' && this.data.canRetry) {
      event.preventDefault();
      this.loadArticle();
    } else if (event.code === 'Backspace') {
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
      pageLabel: this.pages.length ? `${pageIndex + 1} / ${this.pages.length}` : '',
      canGoBack: pageIndex > 0,
      canGoForward: pageIndex < last,
    });
  },

  previousPage() {
    this.showPage(this.data.pageIndex - 1);
  },

  nextPage() {
    this.showPage(this.data.pageIndex + 1);
  },

  toggleAudio() {
    this.player?.toggle();
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
    <view class="reading">
      <text class="body">{{body}}</text>
    </view>
    <view class="footer">
      <button class="control" bindtap="returnToList">返回</button>
      <button class="control" ink:if="{{canRetry}}" bindtap="loadArticle">重试</button>
      <view class="pagination" ink:if="{{hasBody}}">
        <button class="control {{canGoBack ? '' : 'muted'}}" bindtap="previousPage">上一页</button>
        <button class="control {{canGoForward ? '' : 'muted'}}" bindtap="nextPage">下一页</button>
      </view>
      <button class="control audio" ink:if="{{hasAudio}}" bindtap="toggleAudio">{{audioLabel}}</button>
      <text class="meta" ink:elif="{{hasBody}}">{{audioLabel}}</text>
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
  gap: 8px;
  padding: 6px 0;
}
.header { border-bottom: 1px solid rgba(64,255,94,0.30); }
.footer { border-top: 1px solid rgba(64,255,94,0.30); }
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
.reading { flex: 1; padding: 15px 0; }
.body { width: 100%; color: rgba(64,255,94,0.92); font-size: 20px; line-height: 30px; }
.pagination { display: flex; flex-direction: row; gap: 6px; }
.control {
  padding: 5px 8px;
  font-size: 14px;
  line-height: 20px;
  color: rgba(64,255,94,0.85);
  background-color: #000000;
  border: 1px solid rgba(64,255,94,0.38);
  border-radius: 4px;
}
.control:focus, .control:active { border-color: #40ff5e; background-color: rgba(64,255,94,0.12); }
.control.muted { color: rgba(64,255,94,0.46); }
.control.audio { color: #40ff5e; }
</style>

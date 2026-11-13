<script def>
{
  "navigationBarTitleText": "知声账号"
}
</script>

<script setup>
import wx from 'wx';
import { cancelTimer, createRequest, recoveryDelay, zhisheng } from '../../lib/zhisheng.js';

export default {
  data: {
    heading: '绑定知声',
    account: '',
    userCode: '',
    verificationUri: '',
    message: '使用手机浏览器完成绑定。',
    action: '开始绑定',
  },

  onLoad() {
    this.visible = false;
    this.closed = false;
    this.operation = null;
    this.attempt = null;
    this.binding = null;
    this.recoveryAttempts = 0;
  },

  onShow() {
    this.visible = true;
    if (this.closed) return;
    if (this.pairedWhileHidden) {
      this.returnToList();
      return;
    }
    if (this.attempt) {
      this.schedulePoll(this.attempt);
      return;
    }
    if (this.operation) return;
    try {
      const binding = zhisheng.getBinding();
      if (binding?.confirmationRequired) this.resumeBinding();
      else if (binding) this.showBound(binding);
      else if (this.binding) {
        this.binding = null;
        this.showRetry('授权已失效，请重新绑定。');
      }
    } catch {
      this.setData({ message: '无法读取眼镜上的账号信息。', action: '' });
    }
  },

  onHide() {
    this.visible = false;
    this.clearPollTimer();
  },

  onUnload() {
    this.close();
  },

  onKeyUp(event) {
    if (event.code === 'Enter' && this.data.action) {
      event.preventDefault();
      this.primaryAction();
    } else if (event.code === 'Backspace') {
      event.preventDefault();
      this.returnToList();
    }
  },

  primaryAction() {
    if (this.closed || this.operation || this.attempt) return;
    if (this.data.action === '继续绑定' || this.binding?.confirmationRequired) this.resumeBinding();
    else if (this.binding) this.changeAccount();
    else this.startPairing();
  },

  showBound(binding) {
    this.binding = binding;
    this.setData({
      heading: '知声账号', account: binding.account.displayName || '当前账号',
      userCode: '', verificationUri: '',
      message: binding.confirmationRequired ? '账号已保存，连接暂未完成。' : '更换账号会先撤销这副眼镜的访问权限。',
      action: binding.confirmationRequired ? '继续绑定' : '更换账号',
    });
  },

  async resumeBinding() {
    if (this.closed || this.operation) return;
    // 确认由共享内容客户端完成；隐藏或关闭页面不会中断已保存绑定的恢复。
    const operation = {};
    this.clearPollTimer();
    this.operation = operation;
    this.setData({ userCode: '', verificationUri: '', message: '正在确认连接…', action: '' });
    try {
      const binding = await zhisheng.ensureBinding();
      if (this.operation !== operation) return;
      this.operation = null;
      this.binding = binding;
      this.recoveryAttempts = 0;
      if (this.visible) this.returnToList();
      else this.pairedWhileHidden = true;
    } catch (error) {
      if (this.operation !== operation) return;
      this.operation = null;
      if (error.code === 'auth_required') {
        this.binding = null;
        this.showRetry('绑定确认已失效，请重新绑定。');
      } else {
        try {
          const binding = zhisheng.getBinding();
          if (binding) {
            this.showBound(binding);
            const delay = recoveryDelay(error, this.recoveryAttempts++);
            if (this.visible && delay !== null) this.pollTimer = setTimeout(() => this.resumeBinding(), delay);
          }
          else this.showRetry('连接暂未完成，请重试。');
        } catch {
          this.setData({ message: '无法保存账号信息，请重试。', action: '继续绑定' });
        }
      }
    }
  },

  showRetry(message) {
    this.setData({ heading: '绑定知声', account: '', userCode: '', verificationUri: '', message, action: '重新绑定' });
  },

  async changeAccount() {
    const request = createRequest();
    this.operation = request;
    this.setData({ message: '正在撤销当前账号…', action: '' });
    try {
      await zhisheng.revokeBinding(this.binding, request.signal);
    } catch {
      if (this.operation === request) {
        this.operation = null;
        this.setData({ message: '无法完成更换。可重试，或在知声网页撤销。', action: '重试撤销' });
      }
      return;
    }
    if (this.operation !== request) return;
    this.operation = null;
    this.binding = null;
    this.setData({ heading: '绑定知声', account: '' });
    this.startPairing();
  },

  async startPairing() {
    const request = createRequest();
    this.operation = request;
    this.setData({ heading: '绑定知声', message: '正在获取绑定码…', action: '' });
    try {
      const grant = await zhisheng.beginPairing(request.signal);
      if (this.operation !== request) return;
      this.operation = null;
      const attempt = { grant, interval: grant.interval, due: Date.now() + grant.interval, checking: false };
      this.attempt = attempt;
      this.setData({
        userCode: grant.userCode, verificationUri: grant.verificationUri,
        message: '在手机打开网址并输入此码。', action: '',
      });
      this.schedulePoll(attempt);
    } catch {
      if (this.operation !== request) return;
      this.operation = null;
      this.showRetry('无法获取绑定码，请检查连接。');
    }
  },

  clearPollTimer() {
    cancelTimer(this.pollTimer);
    this.pollTimer = null;
  },

  schedulePoll(attempt) {
    if (!this.visible || this.attempt !== attempt || attempt.checking) return;
    this.clearPollTimer();
    const time = Math.min(attempt.due, attempt.grant.expiresAt);
    this.pollTimer = setTimeout(() => this.poll(attempt), Math.max(0, time - Date.now()));
  },

  async poll(attempt) {
    if (!this.visible || this.attempt !== attempt || attempt.checking) return;
    if (Date.now() >= attempt.grant.expiresAt) {
      this.attempt = null;
      this.showRetry('绑定码已过期。');
      return;
    }
    attempt.checking = true;
    let binding;
    try {
      // 交换可能已在服务端签发凭据。离开页面后若收到它，立即撤销。
      binding = await zhisheng.exchangeDeviceCode(attempt.grant.deviceCode);
    } catch (error) {
      if (this.attempt !== attempt) return;
      attempt.checking = false;
      this.handlePollError(attempt, error);
      return;
    }
    if (this.attempt !== attempt) {
      await zhisheng.revokeBinding(binding).catch(() => {});
      return;
    }
    this.attempt = null;
    try {
      zhisheng.saveBinding(binding);
    } catch {
      await zhisheng.revokeBinding(binding).catch(() => {});
      if (!this.closed) this.showRetry('无法保存账号，请重试或到知声网页检查绑定。');
      return;
    }
    this.binding = binding;
    await this.resumeBinding();
  },

  handlePollError(attempt, error) {
    if (error.code === 'slow_down') attempt.interval += 5000;
    else if (error.code === 'network') attempt.interval = Math.max(attempt.interval, Math.min(attempt.interval * 2, 30000));
    else if (error.code !== 'authorization_pending' && error.code !== 'rate_limited') {
      this.attempt = null;
      const message = error.code === 'access_denied' ? '绑定未获同意。'
        : error.code === 'expired_token' || error.code === 'invalid_grant' ? '绑定码已失效。'
        : '绑定遇到问题，请重试。';
      this.showRetry(message);
      return;
    }
    attempt.due = Date.now() + Math.max(attempt.interval, error.retryAfter || 0);
    this.schedulePoll(attempt);
  },

  close() {
    this.closed = true;
    this.visible = false;
    this.clearPollTimer();
    const request = this.operation;
    this.operation = null;
    request?.cancel?.();
    this.attempt = null;
  },

  returnToList() {
    if (this.closed) return;
    this.close();
    wx.navigateBack({ fail: () => wx.redirectTo({
      url: '/pages/index/index',
      fail: () => {
        this.closed = false;
        this.visible = true;
        this.setData({ message: '无法返回，请重试。' });
      },
    }) });
  },
};
</script>

<page>
  <view class="screen">
    <text class="heading">{{heading}}</text>
    <view class="content">
      <text class="account" ink:if="{{account}}">{{account}}</text>
      <text class="message">{{message}}</text>
      <text class="address" ink:if="{{verificationUri}}">{{verificationUri}}</text>
      <text class="code" ink:if="{{userCode}}">{{userCode}}</text>
    </view>
    <view class="footer">
      <button class="control" bindtap="returnToList">返回</button>
      <button class="control" ink:if="{{action}}" bindtap="primaryAction">{{action}}</button>
    </view>
  </view>
</page>

<style>
.screen { width: 100%; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; padding: 14px 24px; background-color: #000000; font-family: sans-serif; }
.heading { padding: 6px 0; border-bottom: 1px solid rgba(64,255,94,0.30); color: #40ff5e; font-size: 22px; font-weight: 600; line-height: 28px; }
.content { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.message, .address { width: 100%; color: rgba(64,255,94,0.84); font-size: 17px; line-height: 24px; }
.account, .code { color: #40ff5e; font-size: 24px; font-weight: 600; line-height: 32px; }
.footer { display: flex; flex-direction: row; align-items: center; justify-content: space-between; padding: 6px 0; border-top: 1px solid rgba(64,255,94,0.30); }
.control { padding: 5px 8px; font-size: 14px; line-height: 20px; color: #40ff5e; background-color: #000000; border: 1px solid rgba(64,255,94,0.38); border-radius: 4px; }
.control:focus, .control:active { border-color: #40ff5e; background-color: rgba(64,255,94,0.12); }
</style>

import { zhishengEnabled, zhishengOrigin } from '../data/zhisheng-config.js';

export const articlePageSize = 12;
const pairErrors = new Set(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant']);
const maxSessionSeconds = 24 * 60 * 60;
const maxAudioBytes = 8 * 1024 * 1024;
const maxCachedAudioBytes = 4 * 1024 * 1024;
const maxCachedAudioCount = 3;

export class ZhishengError extends Error {
  constructor(code, retryAfter = 0) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createRequest() {
  if (typeof AbortController === 'function') {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => controller.abort() };
  }
  // AIUI 还提供直接创建、取消信号的形式。
  try {
    const signal = new AbortSignal();
    if (typeof signal.abort === 'function') return { signal, cancel: () => signal.abort() };
  } catch {
    // 宿主缺少取消能力时，页面仍会丢弃过时结果。
  }
  return { signal: undefined, cancel() {} };
}

async function withRequestDeadline(operation, externalSignal) {
  const control = createRequest();
  const canForward = typeof externalSignal?.addEventListener === 'function';
  const signal = !externalSignal || canForward ? control.signal ?? externalSignal : externalSignal;
  let timer;
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete, value) => {
        if (settled) return;
        settled = true;
        complete(value);
      };
      const cancel = () => { try { control.cancel(); } catch { /* 超时退出不依赖宿主取消成功 */ } };
      onAbort = () => {
        finish(reject, new ZhishengError('network'));
        cancel();
      };
      timer = setTimeout(() => {
        const error = new ZhishengError('network');
        error.timedOut = true;
        finish(reject, error);
        cancel();
      }, 10000);
      if (externalSignal?.aborted) { onAbort(); return; }
      if (canForward) externalSignal.addEventListener('abort', onAbort, { once: true });
      // 同时覆盖响应体读取。即使 fetch 不理会 timeout 或 abort，调用者也能退出等待。
      Promise.resolve().then(() => settled ? undefined : operation(signal)).then(
        (value) => finish(resolve, value), (error) => finish(reject, error),
      );
    });
  } finally {
    cancelTimer(timer);
    if (canForward) externalSignal.removeEventListener?.('abort', onAbort);
  }
}

function httpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) throw new ZhishengError('bad_response');
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url;
  } catch {
    // 将解析异常统一成界面可处理的错误。
  }
  throw new ZhishengError('bad_response');
}

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validToken(value) {
  return isString(value) && value.length <= 4096 && /^[!-~]+$/.test(value);
}

function validBinding(binding) {
  return validToken(binding?.token) && isPositiveInt(binding.expiresAt)
    && isString(binding.bindingId) && isString(binding.account?.id)
    && typeof binding.account.displayName === 'string'
    && (binding.refreshToken === undefined || validToken(binding.refreshToken))
    && (binding.confirmationRequired === undefined || typeof binding.confirmationRequired === 'boolean')
    && (!binding.confirmationRequired || validToken(binding.refreshToken))
    && (binding.upgradePending === undefined || typeof binding.upgradePending === 'boolean');
}

function sameBinding(a, b) {
  return Boolean(a && b && a.bindingId === b.bindingId && a.account.id === b.account.id);
}

function sameCredential(a, b) {
  return sameBinding(a, b) && a.token === b.token && a.refreshToken === b.refreshToken;
}

function validListItem(item) {
  return isString(item?.id) && isString(item.title) && isString(item.publishedAt) && typeof item.hasAudio === 'boolean';
}

export function createZhishengClient({ origin, storage, request = (...args) => fetch(...args), now = Date.now }) {
  let base = '';
  if (origin) {
    try {
      const url = httpsUrl(origin);
      if (url.pathname === '/' && !url.search) base = url.origin;
    } catch {
      // 无效配置仍显示真实模式的配置提示，避免误把演示当成真实内容。
    }
  }
  const mode = !origin ? 'demo' : base ? 'live' : 'invalid';
  const storageKey = `zhiyue.binding.v1:${base}`;
  const store = () => storage ?? globalThis.localStorage;
  const audioCache = new Map();
  let cachedBindingToken = null;
  let cacheExpiry = null;
  let lifecycle = null;
  let legacyUpgradeUnavailable = false;

  function clearAudioCache() {
    audioCache.clear();
    cachedBindingToken = null;
    cancelTimer(cacheExpiry);
    cacheExpiry = null;
  }

  function rememberAudio(binding, releaseId, bytes) {
    if (bytes.byteLength > maxCachedAudioBytes) return;
    if (cachedBindingToken !== binding.token) {
      clearAudioCache();
      cachedBindingToken = binding.token;
      cacheExpiry = watchBindingExpiry(binding, () => {
        if (cachedBindingToken === binding.token) clearAudioCache();
      }, now);
    }
    audioCache.delete(releaseId);
    let total = bytes.byteLength;
    for (const retained of audioCache.values()) total += retained.byteLength;
    while (audioCache.size >= maxCachedAudioCount || total > maxCachedAudioBytes) {
      const oldest = audioCache.keys().next().value;
      total -= audioCache.get(oldest).byteLength;
      audioCache.delete(oldest);
    }
    try {
      // 缓存独立持有副本，播放器可以接管原始缓冲区。
      audioCache.set(releaseId, bytes.slice(0));
    } catch {
      // 内存不足时仍可播放已下载的原始数据。
    }
  }

  function readBinding() {
    try {
      const raw = store().getItem(storageKey);
      if (raw === null) {
        clearAudioCache();
        return null;
      }
      let binding;
      try { binding = JSON.parse(raw); } catch { binding = null; }
      const remaining = binding?.expiresAt - now();
      // 读取凭据过期不等于可续期的逻辑绑定失效；升级中的旧凭据也要保留供恢复。
      if (validBinding(binding) && (remaining > 0 || binding.refreshToken || binding.upgradePending)) {
        if (cachedBindingToken !== null && cachedBindingToken !== binding.token) clearAudioCache();
        return binding;
      }
      clearAudioCache();
      store().removeItem(storageKey);
      return null;
    } catch {
      clearAudioCache();
      throw new ZhishengError('storage');
    }
  }

  function removeBinding(expected) {
    const current = readBinding();
    if (!sameCredential(current, expected)) return;
    clearAudioCache();
    try {
      store().removeItem(storageKey);
    } catch {
      throw new ZhishengError('storage');
    }
  }

  function writeBinding(binding) {
    const { token, expiresAt, bindingId, account: { id, displayName }, refreshToken,
      confirmationRequired, upgradePending } = binding;
    const raw = JSON.stringify({ token, expiresAt, bindingId, account: { id, displayName },
      ...(refreshToken === undefined ? {} : { refreshToken, confirmationRequired: Boolean(confirmationRequired) }),
      ...(upgradePending ? { upgradePending: true } : {}) });
    try {
      store().setItem(storageKey, raw);
      // 不把静默写入失败当作已可靠保存，尤其不能据此确认服务端绑定。
      if (store().getItem(storageKey) !== raw) throw new Error('storage');
    } catch {
      throw new ZhishengError('storage');
    }
  }

  function replaceBinding(expected, next) {
    if (!sameCredential(readBinding(), expected)) throw new ZhishengError('auth_required');
    writeBinding(next);
    if (expected.token !== next.token) clearAudioCache();
    return next;
  }

  function saveBinding(binding) {
    const remaining = binding?.expiresAt - now();
    if (!validBinding(binding) || remaining <= 0 || remaining > maxSessionSeconds * 1000) {
      throw new ZhishengError('bad_response');
    }
    if (readBinding()) throw new ZhishengError('binding_exists');
    writeBinding(binding);
  }

  function call(path, options = {}) {
    return withRequestDeadline((signal) => performCall(path, { ...options, signal }), options.signal);
  }

  async function performCall(path, { method = 'GET', body, binding, signal, revoke = false, empty = false } = {}) {
    if (mode !== 'live') throw new ZhishengError('configuration');
    const headers = { Accept: 'application/json' };
    if (binding) headers.Authorization = `Bearer ${binding.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await request(`${base}/v1/zhiyue${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
        timeout: 10000,
      });
    } catch {
      throw new ZhishengError('network');
    }
    if (response.url && httpsUrl(response.url).origin !== base) throw new ZhishengError('bad_response');
    if (revoke) {
      if (response.status === 204 || (response.status === 401 && !binding?.refreshToken)) return null;
      if (response.status === 401) throw new ZhishengError('auth_required');
      throw new ZhishengError('service');
    }
    if (response.status === 401 && binding) {
      throw new ZhishengError('auth_required');
    }
    if (!response.ok) {
      if (response.status === 403 && binding) throw new ZhishengError('forbidden');
      let error;
      try { error = (await response.json())?.error; } catch { /* 忽略非 JSON 错误页 */ }
      const retryHeader = response.headers?.get?.('Retry-After');
      const seconds = Number(retryHeader);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryHeader) - now();
      const code = pairErrors.has(error) ? error
        : response.status === 429 ? 'rate_limited'
        : response.status === 404 ? 'not_found' : 'service';
      throw new ZhishengError(code, Number.isFinite(delay) ? Math.max(0, delay) : 0);
    }
    if (empty) {
      if (response.status !== 204) throw new ZhishengError('bad_response');
      return null;
    }
    try { return await response.json(); } catch { throw new ZhishengError('bad_response'); }
  }

  function parseGrant(token, expected) {
    if (!isPositiveInt(token?.expires_in) || token.expires_in > maxSessionSeconds
        || ((token.refresh_token !== undefined || token.confirmation_required !== undefined)
          && (!validToken(token.refresh_token) || typeof token.confirmation_required !== 'boolean'))) {
      throw new ZhishengError('bad_response');
    }
    const binding = {
      token: token.access_token, expiresAt: now() + token.expires_in * 1000,
      bindingId: token.binding_id,
      account: { id: token.account?.id, displayName: token.account?.displayName },
      ...(token.refresh_token === undefined ? {} : {
        refreshToken: token.refresh_token, confirmationRequired: token.confirmation_required,
      }),
    };
    if (!validBinding(binding) || (expected && (!sameBinding(binding, expected)
        || !binding.refreshToken || binding.confirmationRequired
        || (expected.refreshToken && binding.refreshToken !== expected.refreshToken)))) {
      throw new ZhishengError('bad_response');
    }
    return binding;
  }

  async function recoverBinding(binding, forceRefresh) {
    let current = binding;
    try {
      if (current.confirmationRequired) {
        try {
          await call('/device/confirm', { method: 'POST', body: { refresh_token: current.refreshToken }, empty: true });
          current = replaceBinding(current, { ...current, confirmationRequired: false });
        } catch (error) {
          if (!error.timedOut) throw error;
          let recovered;
          try {
            // 204 可能已在服务端完成，但转发层未结束响应。只有续期成功才证明绑定已确认。
            const grant = await call('/device/refresh', { method: 'POST', body: { refresh_token: current.refreshToken } });
            recovered = parseGrant(grant, current);
          } catch {
            // 待确认绑定的续期也会被拒绝，不能把探测失败直接当作永久撤销。
            throw error;
          }
          current = replaceBinding(current, recovered);
        }
      }
      if (!current.refreshToken && !legacyUpgradeUnavailable) {
        // 升级请求前记账；响应丢失并跨过旧期限后，仍可用原凭据恢复服务端的升级结果。
        current = replaceBinding(current, { ...current, upgradePending: true });
        try {
          const grant = await call('/device/upgrade', { method: 'POST', body: {}, binding: current });
          current = replaceBinding(current, parseGrant(grant, current));
        } catch (error) {
          if (error.code !== 'not_found' || current.expiresAt <= now()) throw error;
          legacyUpgradeUnavailable = true;
          current = replaceBinding(current, { ...current, upgradePending: false });
        }
      }
      if (current.refreshToken && (forceRefresh || current.expiresAt - now() <= 60000)) {
        const grant = await call('/device/refresh', { method: 'POST', body: { refresh_token: current.refreshToken } });
        current = replaceBinding(current, parseGrant(grant, current));
      }
      if (!sameCredential(readBinding(), current)) throw new ZhishengError('auth_required');
      return current;
    } catch (error) {
      if (['invalid_grant', 'expired_token', 'access_denied'].includes(error.code)
          || (error.code === 'auth_required' && !current.refreshToken)) {
        removeBinding(current);
        throw new ZhishengError('auth_required');
      }
      // 网络、服务或写入失败保留恢复所需的凭据；不把它们显示成已撤销。
      throw error;
    }
  }

  async function ensureBinding(forceRefresh = false) {
    const binding = readBinding();
    if (!binding) throw new ZhishengError('auth_required');
    if (lifecycle) {
      const active = lifecycle;
      if (sameBinding(binding, active.binding)) return active.promise;
      // 旧账号的异步结果不能覆盖新账号，也不能串用旧账号的续期结果。
      await active.promise.catch(() => {});
      return ensureBinding(forceRefresh);
    }
    if (!forceRefresh && !binding.confirmationRequired && !binding.upgradePending
        && ((binding.refreshToken && binding.expiresAt - now() > 60000)
          || (!binding.refreshToken && legacyUpgradeUnavailable))) return binding;
    const active = { binding, promise: null };
    lifecycle = active;
    active.promise = recoverBinding(binding, forceRefresh).finally(() => {
      if (lifecycle === active) lifecycle = null;
    });
    return active.promise;
  }

  async function read(path, options) {
    let binding = await ensureBinding();
    let result;
    try {
      result = await call(path, { ...options, binding });
    } catch (error) {
      if (error.code !== 'auth_required') throw error;
      const current = readBinding();
      if (!sameBinding(current, binding)) throw error;
      if (!current.refreshToken) {
        removeBinding(binding);
        throw error;
      }
      binding = await ensureBinding(current.token === binding.token);
      try { result = await call(path, { ...options, binding }); }
      catch (retryError) {
        // 只有续期明确拒绝时才销毁可恢复绑定；重复 401 可来自并发凭据轮换。
        if (retryError.code === 'auth_required' && sameBinding(readBinding(), binding)) {
          throw new ZhishengError('service');
        }
        throw retryError;
      }
    }
    if (!sameBinding(readBinding(), binding)) throw new ZhishengError('auth_required');
    return result;
  }

  return {
    mode,
    getBinding: readBinding,
    saveBinding,
    ensureBinding,
    async beginPairing(signal) {
      const grant = await call('/device/authorize', { method: 'POST', body: {}, signal });
      if (!validToken(grant?.device_code) || !isString(grant.user_code) || grant.user_code.length > 20
          || !isPositiveInt(grant.expires_in) || grant.expires_in > maxSessionSeconds
          || !isPositiveInt(grant.interval) || grant.interval > grant.expires_in) {
        throw new ZhishengError('bad_response');
      }
      const uri = httpsUrl(grant.verification_uri);
      if (uri.origin !== base) throw new ZhishengError('bad_response');
      return {
        deviceCode: grant.device_code,
        userCode: grant.user_code,
        verificationUri: uri.href,
        expiresAt: now() + grant.expires_in * 1000,
        interval: grant.interval * 1000,
      };
    },
    async exchangeDeviceCode(deviceCode) {
      const token = await call('/device/token', { method: 'POST', body: { device_code: deviceCode } });
      return parseGrant(token);
    },
    async revokeBinding(binding, signal) {
      try {
        await call('/device/binding', { method: 'DELETE', binding, signal, revoke: true });
      } catch (error) {
        if (error.code !== 'auth_required' || !binding.refreshToken) throw error;
        let current;
        try {
          // 访问凭据可能已轮换或过期；401 本身不代表长期绑定已经撤销。
          current = parseGrant(await call('/device/refresh', {
            method: 'POST', body: { refresh_token: binding.refreshToken }, signal,
          }), binding);
        } catch (refreshError) {
          if (!['invalid_grant', 'expired_token', 'access_denied'].includes(refreshError.code)) throw refreshError;
          const saved = readBinding();
          if (sameBinding(saved, binding)) removeBinding(saved);
          return;
        }
        await call('/device/binding', { method: 'DELETE', binding: current, signal, revoke: true });
      }
      const saved = readBinding();
      if (sameBinding(saved, binding)) removeBinding(saved);
    },
    async listArticles(offset, signal) {
      const page = await read(`/read/articles?limit=${articlePageSize}&offset=${offset}`, { signal });
      if (!Array.isArray(page?.items) || !page.items.every(validListItem)
          || page.offset !== offset || page.limit !== articlePageSize
          || !Number.isSafeInteger(page.total) || page.total < 0
          || page.items.length !== Math.min(articlePageSize, Math.max(0, page.total - offset))) {
        throw new ZhishengError('bad_response');
      }
      return page;
    },
    async getArticle(id, signal) {
      const item = await read(`/read/articles/${encodeURIComponent(id)}`, { signal });
      if (!validListItem(item) || item.id !== id || !isString(item.releaseId) || typeof item.text !== 'string') {
        throw new ZhishengError('bad_response');
      }
      return { ...item, paragraphs: item.text.split(/\r\n?|\n/) };
    },
    forgetAudio(releaseId) {
      audioCache.delete(releaseId);
    },
    async getAudioBuffer(releaseId, signal, isCancelled = () => false) {
      let binding = await ensureBinding();
      let ticket;
      try {
        // 命中也取票，确认当前绑定、发布版本和音频仍可访问。
        ticket = await read(`/read/releases/${encodeURIComponent(releaseId)}/audio-ticket`, { method: 'POST', body: {}, signal });
        const current = readBinding();
        if (!sameBinding(current, binding)) throw new ZhishengError('auth_required');
        binding = current;
      } catch (error) {
        if (cachedBindingToken === binding.token && (error.code === 'not_found' || error.code === 'forbidden')) {
          audioCache.delete(releaseId);
        }
        throw error;
      }
      const url = httpsUrl(ticket?.url);
      if (url.origin !== base || !url.pathname.startsWith('/v1/zhiyue/media/')
          || url.search || !isPositiveInt(ticket.expires_in)) {
        throw new ZhishengError('bad_response');
      }

      if (signal?.aborted || isCancelled()) throw new ZhishengError('audio_download');
      const cachedBinding = readBinding();
      if (!sameBinding(cachedBinding, binding)) throw new ZhishengError('auth_required');
      binding = cachedBinding;
      const cached = audioCache.get(releaseId);
      if (cached) {
        audioCache.delete(releaseId);
        let playback;
        try {
          playback = cached.slice(0);
        } catch {
          // 无法再分配副本时，释放缓存并使用已有字节播放。
          return cached;
        }
        audioCache.set(releaseId, cached);
        return playback;
      }

      let bytes;
      try {
        // 单次读取最多 8 MiB，与知声的单份音频上限相同。
        const response = await request(url.href, {
          method: 'GET', headers: { Range: `bytes=0-${maxAudioBytes - 1}` },
          credentials: 'omit', redirect: 'error',
          ...(signal === undefined ? {} : { signal }), timeout: 80000,
        });
        if (response.url && httpsUrl(response.url).origin !== base) throw new ZhishengError('audio_download');
        if (response.status >= 400) {
          const error = new ZhishengError('audio_http');
          error.status = response.status;
          throw error;
        }
        const type = response.headers.get('Content-Type') ?? '';
        if (type.split(';')[0].trim().toLowerCase() !== 'audio/mpeg') throw new ZhishengError('audio_download');
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
        const length = response.status === 206 ? Number(range?.[2]) : Number(response.headers.get('Content-Length'));
        if (!isPositiveInt(length) || length > maxAudioBytes
            || (response.status !== 200 && (response.status !== 206 || Number(range?.[1]) !== length - 1))) {
          throw new ZhishengError('audio_download');
        }
        bytes = await response.arrayBuffer();
        if (bytes.byteLength !== length) throw new ZhishengError('audio_download');
      } catch (error) {
        if (error instanceof ZhishengError) throw error;
        throw new ZhishengError('audio_download');
      }
      const downloadedBinding = readBinding();
      if (!sameBinding(downloadedBinding, binding)) throw new ZhishengError('auth_required');
      binding = downloadedBinding;
      if (signal?.aborted || isCancelled()) throw new ZhishengError('audio_download');
      rememberAudio(binding, releaseId, bytes);
      return bytes;
    },
  };
}

export const zhisheng = createZhishengClient({ origin: zhishengEnabled ? zhishengOrigin : '' });

export function cancelTimer(timer) {
  // Rokid 的计时器只接受数值句柄。
  if (typeof timer === 'number') clearTimeout(timer);
}

export function recoveryDelay(error, attempt = 0) {
  if (!['network', 'service', 'slow_down', 'rate_limited'].includes(error.code)) return null;
  return Math.max(Math.min(1000 * 2 ** Math.min(attempt, 5), 30000), error.retryAfter || 0);
}

export function watchBindingExpiry(binding, expire, now = Date.now) {
  return setTimeout(expire, Math.max(0, binding.expiresAt - now()));
}

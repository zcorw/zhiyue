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
    && typeof binding.account.displayName === 'string';
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
      if (validBinding(binding) && remaining > 0 && remaining <= maxSessionSeconds * 1000) {
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
    if (!current || current.token !== expected.token) return;
    clearAudioCache();
    try {
      store().removeItem(storageKey);
    } catch {
      throw new ZhishengError('storage');
    }
  }

  function saveBinding(binding) {
    const remaining = binding?.expiresAt - now();
    if (!validBinding(binding) || remaining <= 0 || remaining > maxSessionSeconds * 1000) {
      throw new ZhishengError('bad_response');
    }
    if (readBinding()) throw new ZhishengError('binding_exists');
    try {
      const { token, expiresAt, bindingId, account: { id, displayName } } = binding;
      store().setItem(storageKey, JSON.stringify({ token, expiresAt, bindingId, account: { id, displayName } }));
    } catch {
      throw new ZhishengError('storage');
    }
  }

  async function call(path, { method = 'GET', body, binding, signal, revoke = false } = {}) {
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
      if (response.status === 204 || response.status === 401) return null;
      throw new ZhishengError('service');
    }
    if (response.status === 401 && binding) {
      removeBinding(binding);
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
    try { return await response.json(); } catch { throw new ZhishengError('bad_response'); }
  }

  async function read(path, options) {
    const binding = readBinding();
    if (!binding) throw new ZhishengError('auth_required');
    const result = await call(path, { ...options, binding });
    if (readBinding()?.token !== binding.token) throw new ZhishengError('auth_required');
    return result;
  }

  return {
    mode,
    getBinding: readBinding,
    saveBinding,
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
      if (!isPositiveInt(token?.expires_in) || token.expires_in > maxSessionSeconds) {
        throw new ZhishengError('bad_response');
      }
      const binding = {
        token: token.access_token,
        expiresAt: now() + token.expires_in * 1000,
        bindingId: token.binding_id,
        account: { id: token.account?.id, displayName: token.account?.displayName },
      };
      if (!validBinding(binding)) throw new ZhishengError('bad_response');
      return binding;
    },
    async revokeBinding(binding, signal) {
      await call('/device/binding', { method: 'DELETE', binding, signal, revoke: true });
      removeBinding(binding);
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
      const binding = readBinding();
      if (!binding) throw new ZhishengError('auth_required');
      let ticket;
      try {
        // 命中也取票，确认当前绑定、发布版本和音频仍可访问。
        ticket = await read(`/read/releases/${encodeURIComponent(releaseId)}/audio-ticket`, { method: 'POST', body: {}, signal });
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
      if (readBinding()?.token !== binding.token) throw new ZhishengError('auth_required');
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
      if (readBinding()?.token !== binding.token) throw new ZhishengError('auth_required');
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

export function watchBindingExpiry(binding, expire, now = Date.now) {
  return setTimeout(expire, Math.max(0, binding.expiresAt - now()));
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { webcrypto } from 'node:crypto';

const origin = 'https://cms.example.test';
const appRoot = new URL('../aiui/', import.meta.url);
const session = {
  access_token: 'fictional-read-token', expires_in: 86400, binding_id: 'binding-1',
  account: { id: 'user-1', displayName: '演示账号' },
};

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers });
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function createRuntime({ base = origin, request = () => assert.fail('没有预期网络请求'),
  modern = false, storage = new Map(), nativeStorage, files, startTime = 1_800_000_000_000, abortMode = 'standard', Recognition, cryptoApi = webcrypto } = {}) {
  const timerQueue = new Map();
  const navigation = [];
  const players = [];
  const modules = new Map();
  let clock = startTime;
  let nextTimer = 0;
  class Player {
    constructor() { this.callbacks = {}; players.push(this); }
    onCanplay(action) { this.callbacks.ready = action; }
    onPlay(action) { this.callbacks.play = action; }
    onPause(action) { this.callbacks.pause = action; }
    onEnded(action) { this.callbacks.end = action; }
    onError(action) { this.callbacks.error = action; }
    setBuffer(buffer, hint) { this.buffer = buffer; this.hint = hint; }
    play() { this.plays = (this.plays ?? 0) + 1; this.callbacks.play(); }
    pause() { this.callbacks.pause(); }
    stop() { this.stopped = true; }
    destroy() { this.destroyed = true; }
  }
  const wx = {
    navigateTo({ url, complete }) { navigation.push(url); complete?.(); },
    navigateBack() { navigation.push('back'); },
    ...(nativeStorage ? {
      getStorageSync: (key) => nativeStorage.get(key),
      setStorageSync: (key, value) => nativeStorage.set(key, value),
    } : {}),
  };
  const storageApi = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const context = createContext({
    SpeechRecognition: Recognition,
    URL,
    AbortController: abortMode === 'standard' ? AbortController : undefined,
    AbortSignal: abortMode === 'native' ? class {
      aborted = false;
      abort() { this.aborted = true; }
    } : abortMode === 'standard' ? AbortSignal : undefined,
    // 原有用例明确模拟旧后端；新版协议用例须显式启用并处理所有生命周期请求。
    fetch: (href, options) => !modern && href.endsWith('/device/upgrade')
      ? json({ code: 'NOT_FOUND' }, 404) : request(href, options),
    Date: class extends Date { static now() { return clock; } },
    localStorage: storageApi,
    navigator: { storage: files },
    TextDecoder,
    crypto: cryptoApi,
    setTimeout(action, delay) {
      const id = ++nextTimer;
      timerQueue.set(id, { action, due: clock + delay });
      return id;
    },
    clearTimeout(id) {
      assert.equal(typeof id, 'number', 'Rokid 的 clearTimeout 要求数字句柄');
      timerQueue.delete(id);
    },
  });

  function getModule(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let module;
    if (identifier === 'wx' || identifier === 'audio') {
      const [name, value] = identifier === 'wx' ? ['default', wx] : ['AudioPlayer', Player];
      module = new SyntheticModule([name], function () { this.setExport(name, value); }, { context });
    } else {
      let code = readFileSync(fileURLToPath(identifier), 'utf8');
      if (identifier.endsWith('/zhisheng-config.js')) {
        code = `export const zhishengOrigin = ${JSON.stringify(base)}; export const zhishengEnabled = ${base !== null};`;
      } else if (identifier.endsWith('.ink')) {
        JSON.parse(code.match(/<script def>([\s\S]*?)<\/script>/)[1]);
        code = code.match(/<script setup>([\s\S]*?)<\/script>/)[1];
      }
      module = new SourceTextModule(code, { context, identifier });
    }
    modules.set(identifier, module);
    return module;
  }

  async function load(relativePath) {
    const module = getModule(new URL(relativePath, appRoot).href);
    if (module.status === 'unlinked') {
      await module.link((specifier, importer) => getModule(specifier.startsWith('.')
        ? new URL(specifier, importer.identifier).href : specifier));
    }
    if (module.status === 'linked') await module.evaluate();
    return module.namespace;
  }

  async function page(name, query) {
    const route = `pages/${name}/index.ink`;
    const logic = (await load(route)).default;
    const template = readFileSync(new URL(route, appRoot), 'utf8');
    for (const [, handler] of template.matchAll(/bindtap="([^"]+)"/g)) {
      assert.equal(typeof logic[handler], 'function');
    }
    const instance = {
      ...logic, data: structuredClone(logic.data),
      setData(patch) { Object.assign(this.data, patch); },
    };
    instance.onLoad(query);
    instance.onShow();
    return instance;
  }

  async function advance(milliseconds) {
    clock += milliseconds;
    for (const [id, { action, due }] of timerQueue) {
      if (due <= clock) {
        timerQueue.delete(id);
        await action();
      }
    }
  }

  return { load, page, storage, storageApi, navigation, players, advance, timerQueue, now: () => clock };
}

function press(page, code) {
  let used = false;
  page.onKeyUp({ code, preventDefault() { used = true; } });
  return used;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

const epoch = 1_800_000_000_000;
const renewable = (extra = {}) => ({
  token: 'fictional-access', refreshToken: 'fictional-refresh', confirmationRequired: false,
  expiresAt: epoch + 300000, bindingId: 'binding-1', account: { ...session.account }, ...extra,
});
const modernGrant = (extra = {}) => ({ ...session, access_token: 'fictional-access',
  refresh_token: 'fictional-refresh', confirmation_required: true, ...extra });
const emptyLibrary = () => json({ items: [], total: 0, offset: 0, limit: 12 });

function fileBackend() {
  const contents = new Map();
  const state = { failClose: false, gate: null, writes: 0 };
  return {
    contents, state,
    async getDirectory() {
      return {
        async getFileHandle(name, { create }) {
          if (!contents.has(name)) {
            if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
            contents.set(name, '');
          }
          return {
            async getFile() { return new Blob([contents.get(name)]); },
            async createWritable() {
              let buffer = contents.get(name);
              let position = 0;
              return {
                async truncate(size) { assert.equal(size, 0); buffer = ''; },
                async seek(value) { position = value; },
                async write(value) {
                  // 模拟宿主覆盖短文本仍留旧尾部，必须由调用者显式截断。
                  buffer = buffer.slice(0, position) + value + buffer.slice(position + value.length);
                  position += value.length;
                },
                async close() {
                  if (state.gate) await state.gate.promise;
                  if (state.failClose) throw new Error('disk unavailable');
                  contents.set(name, buffer); state.writes += 1;
                },
              };
            },
          };
        },
      };
    },
  };
}

test('键值存储随运行重置时，私有文件保持同一设备及可续期绑定，撤销不会从旧副本复活', async () => {
  const files = fileBackend();
  let pairings = 0;
  const identities = [];
  const request = async (href, options) => {
    identities.push(options.headers['X-Zhiyue-Device-Id']);
    if (href.endsWith('/authorize')) { pairings += 1; return json({ device_code: 'fictional-device-code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 }); }
    if (href.endsWith('/confirm') || options.method === 'DELETE') return new Response(null, { status: 204 });
    if (href.endsWith('/refresh')) return json(modernGrant({ access_token: 'new-access', confirmation_required: false }));
    return json({ items: [{ id: 'article-1', title: '文件恢复的发布文章', publishedAt: '2026-11-17', hasAudio: false }],
      total: 1, offset: 0, limit: 12 });
  };
  const first = createRuntime({ modern: true, files, nativeStorage: new Map(), cryptoApi: null, request });
  const client = (await first.load('lib/zhisheng.js')).zhisheng;
  await client.beginPairing();
  await client.saveBinding(renewable({ confirmationRequired: true }));
  await client.ensureBinding();
  const id = client.getDeviceId();
  const second = createRuntime({ modern: true, files, nativeStorage: new Map(), request, startTime: epoch + 2 * 86400000 });
  const resumed = (await second.load('lib/zhisheng.js')).zhisheng;
  const page = await second.page('index'); await settle();
  assert.equal(page.data.rows[0]?.title, '文件恢复的发布文章');
  assert.equal(resumed.getDeviceId(), id);
  assert.equal(resumed.getBinding().token, 'new-access');
  assert.equal(pairings, 1);
  assert.ok(identities.every((value) => value === id));
  const stale = JSON.stringify(resumed.getBinding());
  await resumed.revokeBinding(resumed.getBinding());
  const third = createRuntime({ modern: true, files, nativeStorage: new Map(), request });
  third.storage.set(`zhiyue.binding.v1:${origin}`, stale);
  const revoked = (await third.load('lib/zhisheng.js')).zhisheng;
  await revoked.ready();
  assert.equal(revoked.getBinding(), null);
  assert.equal(revoked.getDeviceId(), id);
  const disk = JSON.parse(files.contents.get('zhiyue-credentials-v1.json'));
  assert.equal(disk.values[`zhiyue.binding.v1:${origin}`], '__zhiyue_removed_v1__');
  page.onUnload();
});

test('私有文件关闭及回读校验前不确认绑定，文件写入失败保留恢复信息并禁止确认', async () => {
  const files = fileBackend();
  let confirms = 0;
  const runtime = createRuntime({ modern: true, files, request: async (href) => {
    if (href.endsWith('/confirm')) { confirms += 1; return new Response(null, { status: 204 }); }
    return emptyLibrary();
  } });
  const client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  await client.ready();
  files.state.gate = deferred();
  const saving = client.saveBinding(renewable({ confirmationRequired: true }));
  const confirming = client.ensureBinding();
  await settle();
  assert.equal(confirms, 0);
  files.state.gate.resolve(); files.state.gate = null;
  await saving; await confirming;
  assert.equal(confirms, 1);
  const brokenFiles = fileBackend();
  const broken = createRuntime({ modern: true, files: brokenFiles, request: async () => { confirms += 1; assert.fail('未落盘不能请求'); } });
  const pending = (await broken.load('lib/zhisheng.js')).zhisheng;
  await pending.ready();
  brokenFiles.state.failClose = true;
  await assert.rejects(pending.saveBinding(renewable({ confirmationRequired: true })), { code: 'storage' });
  await assert.rejects(pending.ensureBinding(), { code: 'storage' });
  assert.equal(pending.getBinding().refreshToken, 'fictional-refresh');
  assert.equal(confirms, 1);
});

test('私有文件迁移旧授权，读取损坏或后端不可用时不覆盖，也不显示为未绑定', async () => {
  const files = fileBackend();
  const runtime = createRuntime({ modern: true, files, nativeStorage: new Map() });
  const raw = JSON.stringify(renewable());
  runtime.storage.set(`zhiyue.binding.v1:${origin}`, raw);
  const client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  await client.ready();
  assert.equal(client.getBinding().refreshToken, 'fictional-refresh');
  await settle();
  const adapter = (await runtime.load('lib/storage.js')).createPersistentStorage({ files, legacy: runtime.storageApi, native: {} });
  await adapter.ready();
  assert.equal(adapter.getItem(`zhiyue.binding.v1:${origin}`), raw);
  await adapter.flush();
  assert.ok(files.contents.get('zhiyue-credentials-v1.json').includes('fictional-refresh'));
  files.contents.set('zhiyue-credentials-v1.json', '{broken');
  const corrupt = createRuntime({ modern: true, files });
  const page = await corrupt.page('index'); await settle();
  assert.equal(page.data.canPair, false);
  assert.equal(page.data.message, '无法读取眼镜上的账号信息。');
  assert.equal(files.contents.get('zhiyue-credentials-v1.json'), '{broken');
  const unavailable = createRuntime({ files: { getDirectory: async () => { throw new Error('NotSupportedError'); } } });
  const unavailablePage = await unavailable.page('pair'); await settle();
  assert.equal(unavailablePage.data.action, '');
  assert.equal(unavailablePage.data.message, '无法读取眼镜上的账号信息。');
  page.onUnload(); unavailablePage.onUnload();
});

test('原生凭据跨运行时及一天后恢复，localStorage 清空也不重新配对', async () => {
  const nativeStorage = new Map();
  let pairRequests = 0;
  let refreshes = 0;
  const request = async (href) => {
    if (href.endsWith('/authorize')) { pairRequests += 1; assert.fail('已绑定设备不应再次配对'); }
    if (href.endsWith('/refresh')) {
      refreshes += 1;
      return json(modernGrant({ access_token: 'after-restart', confirmation_required: false }));
    }
    return emptyLibrary();
  };
  const first = createRuntime({ modern: true, nativeStorage, request });
  const original = (await first.load('lib/zhisheng.js')).zhisheng;
  original.saveBinding(renewable());
  assert.equal(first.storage.size, 0, '凭据应保存在原生存储');
  const next = createRuntime({ modern: true, nativeStorage, request, startTime: epoch + 2 * 86400000 });
  const client = (await next.load('lib/zhisheng.js')).zhisheng;
  assert.equal(client.getBinding().refreshToken, 'fictional-refresh');
  const library = await next.page('index');
  await settle();
  assert.equal(library.data.bound, true);
  assert.equal(client.getBinding().token, 'after-restart');
  assert.equal(refreshes, 1);
  assert.equal(pairRequests, 0);
});

test('原生存储兼容迁移旧凭据，写入失败不确认，注销不会恢复旧副本', async () => {
  const nativeStorage = new Map();
  const runtime = createRuntime({ modern: true, nativeStorage, request: async () => new Response(null, { status: 204 }) });
  const key = `zhiyue.binding.v1:${origin}`;
  const legacy = JSON.stringify(renewable());
  runtime.storage.set(key, legacy);
  const client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  const binding = client.getBinding();
  assert.equal(nativeStorage.get(key), legacy);
  await client.revokeBinding(binding);
  runtime.storage.set(key, legacy);
  assert.equal(client.getBinding(), null, '注销标记必须阻止旧存储副本恢复');
  const { createPersistentStorage } = await runtime.load('lib/storage.js');
  const broken = createPersistentStorage({ native: { getStorageSync: () => undefined, setStorageSync() {} }, legacy: runtime.storageApi });
  assert.throws(() => broken.setItem(key, legacy), /did not persist/);
});

test('wx 与 localStorage 共用底层时绑定、读文、跨日续期和撤销均保留正确状态', async () => {
  const shared = new Map();
  const request = async (href, options) => {
    if (href.endsWith('/authorize')) return json({ device_code: 'fictional-device-code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    if (href.endsWith('/confirm') || options.method === 'DELETE') return new Response(null, { status: 204 });
    if (href.endsWith('/refresh')) return json(modernGrant({ confirmation_required: false }));
    return json({ items: [{ id: 'article-1', title: '共用存储的发布文章', publishedAt: '2026-11-17', hasAudio: false }],
      total: 1, offset: 0, limit: 12 });
  };
  const first = createRuntime({ modern: true, storage: shared, nativeStorage: shared, cryptoApi: null, request });
  const client = (await first.load('lib/zhisheng.js')).zhisheng;
  const pair = await first.page('pair'); await pair.startPairing();
  assert.equal(pair.data.userCode, 'ABCD-EFGH');
  const id = client.getDeviceId();
  client.saveBinding(renewable({ confirmationRequired: true }));
  await client.ensureBinding();
  const library = await first.page('index'); await settle();
  assert.equal(library.data.rows[0]?.title, '共用存储的发布文章');
  assert.equal(client.getBinding().confirmationRequired, false);
  const next = createRuntime({ modern: true, storage: shared, nativeStorage: shared, cryptoApi: null, request, startTime: epoch + 2 * 86400000 });
  const resumed = (await next.load('lib/zhisheng.js')).zhisheng;
  const reopened = await next.page('index'); await settle();
  assert.equal(reopened.data.rows[0]?.title, '共用存储的发布文章');
  assert.equal(resumed.getDeviceId(), id);
  await resumed.revokeBinding(resumed.getBinding());
  assert.equal(resumed.getBinding(), null);
  assert.equal(resumed.getDeviceId(), id);
  const { createPersistentStorage } = await next.load('lib/storage.js');
  const legacyOnly = createPersistentStorage({ native: {}, legacy: next.storageApi });
  assert.equal(legacyOnly.getItem(`zhiyue.binding.v1:${origin}`), null, '旧接口也应识别撤销标记');
  pair.onUnload(); library.onUnload(); reopened.onUnload();
});

test('同一安装重启、解绑和再次配对使用同一设备标识，不同安装彼此隔离', async () => {
  const nativeStorage = new Map();
  const observed = [];
  const request = async (href, options) => {
    observed.push(options.headers['X-Zhiyue-Device-Id']);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return json({ device_code: 'fictional-device-code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
  };
  const first = createRuntime({ nativeStorage, request });
  const a = (await first.load('lib/zhisheng.js')).zhisheng;
  const id = a.getDeviceId();
  a.saveBinding(renewable());
  await a.revokeBinding(a.getBinding());
  await a.beginPairing();
  const second = createRuntime({ nativeStorage, request });
  const b = (await second.load('lib/zhisheng.js')).zhisheng;
  assert.equal(b.getDeviceId(), id);
  await b.beginPairing();
  assert.ok(observed.every((value) => value === id));
  const other = createRuntime({ nativeStorage: new Map() });
  assert.notEqual((await other.load('lib/zhisheng.js')).zhisheng.getDeviceId(), id);
});

test('Crypto 缺失或不可调用时仍可获取绑定码、加载文章并跨日恢复同一设备身份', async (t) => {
  for (const [name, cryptoApi] of [['missing', null], ['no-method', {}],
    ['unavailable', { getRandomValues() { throw new Error('Host API unavailable'); } }]]) {
    await t.test(name, async () => {
      const nativeStorage = new Map();
      const calls = [];
      const request = async (href, options) => {
        calls.push({ href, id: options.headers['X-Zhiyue-Device-Id'] });
        if (href.endsWith('/authorize')) return json({ device_code: 'fictional-device-code', user_code: 'ABCD-EFGH',
          verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
        if (href.endsWith('/refresh')) return json(modernGrant({ confirmation_required: false }));
        return json({ items: [{ id: 'article-1', title: '已发布文章', publishedAt: '2026-11-17', hasAudio: false }],
          total: 1, offset: 0, limit: 12 });
      };
      const runtime = createRuntime({ modern: true, cryptoApi, nativeStorage, request });
      const client = (await runtime.load('lib/zhisheng.js')).zhisheng;
      const pair = await runtime.page('pair');
      await pair.startPairing();
      assert.equal(pair.data.userCode, 'ABCD-EFGH');
      const id = calls[0].id;
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      // 模拟眼镜上已有授权、但还没有新增安装标识的升级场景。
      nativeStorage.delete(`zhiyue.device.v1:${origin}`);
      client.saveBinding(renewable());
      const library = await runtime.page('index'); await settle();
      assert.equal(library.data.rows[0]?.title, '已发布文章');
      const persistedId = client.getDeviceId();
      const restarted = createRuntime({ modern: true, cryptoApi: webcrypto, nativeStorage, request, startTime: epoch + 2 * 86400000 });
      const resumed = (await restarted.load('lib/zhisheng.js')).zhisheng;
      const reopened = await restarted.page('index'); await settle();
      assert.equal(reopened.data.rows[0]?.title, '已发布文章');
      assert.equal(resumed.getDeviceId(), persistedId);
      assert.ok(calls.slice(1).every((call) => call.id === persistedId));
      pair.onUnload(); library.onUnload(); reopened.onUnload();
    });
  }
});

test('兼容 main 已保存的待确认字段，旧标记不能被新字段绕过', async () => {
  const calls = [];
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (href.endsWith('/confirm')) {
      calls.push('confirm');
      return new Response(null, { status: 204 });
    }
    if (href.endsWith('/refresh')) {
      calls.push('refresh');
      return json(modernGrant({ confirmation_required: false, access_token: 'migrated-access' }));
    }
    calls.push('read');
    return emptyLibrary();
  } });
  runtime.storage.set(`zhiyue.binding.v1:${origin}`, JSON.stringify(renewable({
    expiresAt: epoch - 1000, pendingConfirmation: true, confirmationRequired: false,
  })));
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  assert.equal(zhisheng.getBinding().confirmationRequired, true);
  await zhisheng.listArticles(0);
  assert.deepEqual(calls, ['confirm', 'refresh', 'read']);
  const stored = JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`));
  assert.equal(stored.confirmationRequired, false);
  assert.equal(stored.pendingConfirmation, undefined);
});

test('媒体拒绝后复核授权，明确失效立即停止播放并清理阅读状态', async () => {
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/refresh')) return json({ error: 'invalid_token' }, 400);
    if (href.endsWith('/audio-ticket')) return json({ url: `${origin}/v1/zhiyue/media/private-ticket`, expires_in: 150 });
    if (href.includes('/media/')) return new Response(null, { status: 401 });
    return json({ id: 'article', releaseId: 'release', title: '标题', publishedAt: '2026-11-13',
      hasAudio: true, text: '正文。' });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const reader = await runtime.page('reader', { id: 'article' });
  await settle();
  assert.equal(reader.data.hasBody, true);
  press(reader, 'Enter');
  await settle();
  assert.equal(zhisheng.getBinding(), null);
  assert.equal(reader.data.hasAudio, false);
  assert.equal(reader.data.hasBody, false);
  assert.match(reader.data.body, /授权已失效/);
  assert.equal(runtime.players.length, 0);
});

test('宿主忽略 timeout 和取消时，设备请求仍在十秒退出等待', async (t) => {
  for (const abortMode of ['standard', 'native', 'none']) await t.test(abortMode, async () => {
    let signal;
    const runtime = createRuntime({ modern: true, abortMode, request: async (_href, options) => {
      signal = options.signal;
      return new Promise(() => {});
    } });
    const { zhisheng } = await runtime.load('lib/zhisheng.js');
    const request = assert.rejects(zhisheng.exchangeDeviceCode('private-code'), { code: 'network', timedOut: true });
    await settle();
    await runtime.advance(10000);
    await request;
    if (abortMode !== 'none') assert.equal(signal.aborted, true);
    assert.equal(runtime.timerQueue.size, 0);
    assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 0);
  });
});

test('响应头已返回但 JSON 响应体挂起时也有截止时间，迟到结果不保存', async () => {
  const body = deferred();
  const runtime = createRuntime({ modern: true, request: async () => ({ ok: true, status: 200, json: () => body.promise }) });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const request = assert.rejects(zhisheng.exchangeDeviceCode('private-code'), { code: 'network', timedOut: true });
  await settle();
  await runtime.advance(10000);
  await request;
  body.resolve(modernGrant());
  await settle();
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 0);
  assert.equal(runtime.timerQueue.size, 0);
});

test('确认已完成但 204 一直不返回时，用续期成功证明确认并恢复读取', async () => {
  const calls = [];
  let signal;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (href.endsWith('/confirm')) {
      calls.push('confirm');
      signal = options.signal;
      return new Promise(() => {});
    }
    if (href.endsWith('/refresh')) {
      calls.push('refresh');
      const saved = JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`));
      assert.equal(saved.confirmationRequired, true);
      assert.deepEqual(JSON.parse(options.body), { refresh_token: saved.refreshToken });
      return json(modernGrant({ access_token: 'recovered-confirm-access', confirmation_required: false }));
    }
    calls.push('read');
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const pair = await runtime.page('pair');
  await settle();
  await runtime.advance(10000);
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(pair.closed, true);
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  assert.equal(zhisheng.getBinding().token, 'recovered-confirm-access');
  await zhisheng.listArticles(0);
  assert.deepEqual(calls, ['confirm', 'refresh', 'read']);
});

test('确认超时后续期探测被拒绝不等于撤销，保留待确认状态并允许重试', async () => {
  const lateConfirmation = deferred();
  let confirms = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/confirm')) {
      confirms += 1;
      return confirms === 1 ? lateConfirmation.promise : new Response(null, { status: 204 });
    }
    assert.ok(href.endsWith('/refresh'));
    return json({ error: 'invalid_grant' }, 400);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const pair = await runtime.page('pair');
  await settle();
  await runtime.advance(10000);
  await settle();
  assert.equal(zhisheng.getBinding().confirmationRequired, true);
  assert.equal(pair.data.action, '继续绑定');
  lateConfirmation.resolve(new Response(null, { status: 204 }));
  await settle();
  assert.equal(zhisheng.getBinding().confirmationRequired, true, '迟到响应不能改写已经退出的调用结果');
  await runtime.advance(1000);
  await settle();
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  assert.equal(confirms, 2);
});

test('确认及恢复探测都挂起时，释放共享恢复任务，后续仍能确认', async () => {
  let available = false;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (available && href.endsWith('/confirm')) return new Response(null, { status: 204 });
    return new Promise(() => {});
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const failure = assert.rejects(zhisheng.ensureBinding(), { code: 'network', timedOut: true });
  await settle();
  await runtime.advance(10000);
  await settle();
  await runtime.advance(10000);
  await failure;
  assert.equal(zhisheng.getBinding().confirmationRequired, true);
  available = true;
  await zhisheng.ensureBinding();
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  assert.equal(runtime.timerQueue.size, 0);
});

test('页面取消会中断自己的读取并移除截止计时器', async () => {
  let signal;
  const runtime = createRuntime({ modern: true, request: async (_href, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const controller = new AbortController();
  const failure = assert.rejects(zhisheng.listArticles(0, controller.signal), { code: 'network' });
  await settle();
  controller.abort();
  await failure;
  assert.equal(signal.aborted, true);
  assert.equal(runtime.timerQueue.size, 0);
  assert.ok(zhisheng.getBinding());
});

test('新版首次绑定先可靠保存、确认 204，再读取；不会直接触发 401', async () => {
  const calls = [];
  let confirmed = false;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    const path = new URL(href).pathname;
    calls.push(path);
    if (path.endsWith('/authorize')) return json({ device_code: 'private-device-code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 }, 201);
    if (path.endsWith('/token')) return json(modernGrant());
    if (path.endsWith('/confirm')) {
      const saved = JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`));
      assert.equal(saved.refreshToken, 'fictional-refresh');
      assert.equal(saved.confirmationRequired, true);
      assert.deepEqual(JSON.parse(options.body), { refresh_token: saved.refreshToken });
      assert.equal(options.headers.Authorization, undefined);
      confirmed = true;
      return new Response(null, { status: 204 });
    }
    assert.equal(confirmed, true, '待确认绑定不能先读取');
    assert.equal(options.headers.Authorization, 'Bearer fictional-access');
    return emptyLibrary();
  } });
  const pair = await runtime.page('pair');
  await pair.startPairing();
  await runtime.advance(5000);
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`)).confirmationRequired, false);
  assert.equal(JSON.stringify(pair.data).includes('fictional-refresh'), false);
  const library = await runtime.page('index');
  await settle();
  assert.equal(library.data.bound, true);
  assert.deepEqual(calls, ['/v1/zhiyue/device/authorize', '/v1/zhiyue/device/token',
    '/v1/zhiyue/device/confirm', '/v1/zhiyue/read/articles']);
});

test('存储静默写入失败时不确认，撤销待确认绑定', async () => {
  let confirmed = 0;
  let revoked = 0;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (href.endsWith('/authorize')) return json({ device_code: 'private-code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    if (href.endsWith('/token')) return json(modernGrant());
    if (href.endsWith('/confirm')) confirmed += 1;
    else if (options.method === 'DELETE') revoked += 1;
    else assert.fail('未预期的读取');
    return new Response(null, { status: 204 });
  } });
  (await runtime.load('lib/zhisheng.js')).zhisheng.getDeviceId();
  runtime.storageApi.setItem = () => {};
  const pair = await runtime.page('pair');
  await pair.startPairing();
  await runtime.advance(5000);
  assert.equal(confirmed, 0);
  assert.equal(revoked, 1);
  assert.match(pair.data.message, /无法保存/);
});

test('确认响应丢失或确认后写盘失败，重启后可幂等确认并恢复过期读取凭据', async (t) => {
  for (const failure of ['lost-response', 'storage']) await t.test(failure, async () => {
    let confirms = 0;
    let refreshes = 0;
    let serverConfirmed = false;
    let fail = true;
    let runtime;
    const request = async (href) => {
      if (href.endsWith('/confirm')) {
        confirms += 1;
        serverConfirmed = true;
        if (fail && failure === 'lost-response') throw new Error('response lost');
        if (fail && failure === 'storage') runtime.storageApi.setItem = () => { throw new Error('disk'); };
        return new Response(null, { status: 204 });
      }
      if (href.endsWith('/refresh')) {
        assert.equal(serverConfirmed, true);
        refreshes += 1;
        return json(modernGrant({ access_token: 'renewed-after-restart', confirmation_required: false }));
      }
      assert.equal(serverConfirmed, true);
      return emptyLibrary();
    };
    runtime = createRuntime({ modern: true, request });
    const { zhisheng } = await runtime.load('lib/zhisheng.js');
    zhisheng.saveBinding(renewable({ confirmationRequired: true }));
    await assert.rejects(zhisheng.ensureBinding(), { code: failure === 'storage' ? 'storage' : 'network' });
    assert.equal(zhisheng.getBinding().confirmationRequired, true);
    fail = false;
    runtime = createRuntime({ modern: true, request, storage: runtime.storage, startTime: epoch + 90 * 86400000 });
    const resumed = (await runtime.load('lib/zhisheng.js')).zhisheng;
    await resumed.listArticles(0);
    assert.equal(confirms, 2);
    assert.equal(refreshes, 1);
    assert.equal(resumed.getBinding().token, 'renewed-after-restart');
    assert.equal(resumed.getBinding().confirmationRequired, false);
  });
});

test('待确认绑定超时或已撤销时清理；确认网络失败则保留并显示继续绑定', async () => {
  let rejected = false;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    assert.ok(href.endsWith('/confirm'));
    if (rejected) return json({ error: 'invalid_grant' }, 400);
    throw new Error('offline');
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const pair = await runtime.page('pair');
  await settle();
  assert.equal(pair.data.action, '继续绑定');
  assert.equal(zhisheng.getBinding().confirmationRequired, true);
  rejected = true;
  await pair.resumeBinding();
  assert.equal(zhisheng.getBinding(), null);
  assert.match(pair.data.message, /失效/);
});

test('多轮续期与长期闲置后恢复，临时失败不清除绑定，应用重启仍可恢复', async () => {
  let renewals = 0;
  let failure = null;
  let runtime;
  const request = async (href, options) => {
    if (href.endsWith('/refresh')) {
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'fictional-refresh' });
      if (failure === 'network') throw new Error('offline');
      if (failure === 'service') return json({ error: 'temporarily_unavailable' }, 503);
      if (failure === 'rate') return json({ error: 'slow_down' }, 429, { 'Retry-After': '60' });
      renewals += 1;
      return json(modernGrant({ access_token: `renewed-${renewals}`, confirmation_required: false }));
    }
    assert.ok(href.includes('/read/articles?'));
    assert.equal(options.headers.Authorization, `Bearer renewed-${renewals}`);
    return emptyLibrary();
  };
  runtime = createRuntime({ modern: true, request });
  let client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  client.saveBinding(renewable({ expiresAt: epoch + 1000 }));
  for (let i = 0; i < 3; i += 1) {
    await runtime.advance(30 * 86400000);
    await client.listArticles(0);
  }
  assert.equal(renewals, 3);
  await runtime.advance(40 * 86400000);
  for (failure of ['network', 'service', 'rate']) {
    await assert.rejects(client.listArticles(0));
    assert.equal(client.getBinding().refreshToken, 'fictional-refresh');
  }
  failure = null;
  runtime = createRuntime({ modern: true, request, storage: runtime.storage, startTime: runtime.now() });
  client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  await client.listArticles(0);
  assert.equal(renewals, 4);
});

test('续期响应丢失后仍可用稳定刷新凭据重试，并发读取只发一次续期', async () => {
  let renewals = 0;
  const response = deferred();
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/refresh')) {
      renewals += 1;
      if (renewals === 1) throw new Error('response lost');
      return response.promise;
    }
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ expiresAt: epoch + 1000 }));
  await runtime.advance(2000);
  await assert.rejects(zhisheng.listArticles(0), { code: 'network' });
  const reads = [zhisheng.listArticles(0), zhisheng.listArticles(0), zhisheng.ensureBinding()];
  await settle();
  assert.equal(renewals, 2);
  response.resolve(json(modernGrant({ access_token: 'recovered-access', confirmation_required: false })));
  await Promise.all(reads);
  assert.equal(zhisheng.getBinding().token, 'recovered-access');
});

test('访问凭据被拒绝时先续期再重读，续期明确拒绝才清理并要求重新配对', async () => {
  let revoked = false;
  const calls = [];
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    calls.push(href.endsWith('/refresh') ? 'refresh' : 'read');
    if (href.endsWith('/refresh')) return revoked ? json({ error: 'invalid_grant' }, 400)
      : json(modernGrant({ access_token: 'accepted-access', confirmation_required: false }));
    if (revoked || options.headers.Authorization !== 'Bearer accepted-access') return json({ error: 'invalid_token' }, 401);
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  await zhisheng.listArticles(0);
  assert.deepEqual(calls, ['read', 'refresh', 'read']);
  revoked = true;
  const library = await runtime.page('index');
  await settle();
  assert.equal(zhisheng.getBinding(), null);
  assert.equal(library.data.bound, false);
  assert.match(library.data.message, /授权已失效/);
});

test('账号切换期间迟到的续期结果不能覆盖或清除新账号', async () => {
  const pending = deferred();
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    assert.ok(href.endsWith('/refresh'));
    return pending.promise;
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const old = renewable({ expiresAt: epoch + 1000 });
  zhisheng.saveBinding(old);
  const renewal = assert.rejects(zhisheng.ensureBinding(), { code: 'auth_required' });
  await zhisheng.revokeBinding(old);
  const next = renewable({ token: 'new-account-token', refreshToken: 'new-account-refresh',
    bindingId: 'binding-2', account: { id: 'account-2', displayName: '另一个账号' } });
  zhisheng.saveBinding(next);
  pending.resolve(json(modernGrant({ access_token: 'late-access', confirmation_required: false })));
  await renewal;
  assert.equal(zhisheng.getBinding().token, next.token);
  assert.equal(zhisheng.getBinding().account.id, next.account.id);
});

test('有效旧绑定自动升级，升级响应丢失且跨旧期限后重启仍可恢复', async () => {
  let attempts = 0;
  let runtime;
  const request = async (href, options) => {
    if (href.endsWith('/upgrade')) {
      assert.equal(options.headers.Authorization, 'Bearer legacy-access');
      const saved = JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`));
      assert.equal(saved.upgradePending, true);
      attempts += 1;
      if (attempts === 1) throw new Error('response lost');
      return json(modernGrant({ access_token: 'upgraded-access', confirmation_required: false }));
    }
    return emptyLibrary();
  };
  runtime = createRuntime({ modern: true, request });
  const client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  client.saveBinding({ token: 'legacy-access', expiresAt: epoch + 1000,
    bindingId: session.binding_id, account: session.account });
  await assert.rejects(client.ensureBinding(), { code: 'network' });
  runtime = createRuntime({ modern: true, request, storage: runtime.storage, startTime: epoch + 2000 });
  const resumed = (await runtime.load('lib/zhisheng.js')).zhisheng;
  await resumed.listArticles(0);
  assert.equal(attempts, 2);
  assert.equal(resumed.getBinding().token, 'upgraded-access');
  assert.equal(resumed.getBinding().bindingId, session.binding_id);
  assert.equal(resumed.getBinding().upgradePending, undefined);
});

test('未开始升级的过期旧绑定不会升级，续期响应不能跨账号或逻辑设备', async () => {
  let calls = 0;
  const runtime = createRuntime({ modern: true, request: async () => {
    calls += 1;
    return json(modernGrant({ account: { id: 'wrong-account', displayName: '' }, confirmation_required: false }));
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'legacy', expiresAt: epoch + 1000, bindingId: session.binding_id, account: session.account });
  await runtime.advance(2000);
  await assert.rejects(zhisheng.ensureBinding(), { code: 'auth_required' });
  assert.equal(calls, 0);
  zhisheng.saveBinding(renewable({ expiresAt: runtime.now() + 1000 }));
  await assert.rejects(zhisheng.ensureBinding(), { code: 'bad_response' });
  assert.equal(zhisheng.getBinding().account.id, session.account.id);
});

test('续期后的页面计时器自动读取，保持选文与正文位置，不显示失效', async () => {
  let renewals = 0;
  const items = [{ id: 'one', title: '第一篇', publishedAt: '2026-11-13', hasAudio: false },
    { id: 'two', title: '第二篇', publishedAt: '2026-11-13', hasAudio: false }];
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/refresh')) {
      renewals += 1;
      return json(modernGrant({ access_token: `renewed-${renewals}`, confirmation_required: false }));
    }
    if (href.includes('/read/articles?')) return json({ items, total: 2, limit: 12, offset: 0 });
    return json({ ...items[1], releaseId: 'release-two', text: '第一段。\n第二段。' });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const library = await runtime.page('index');
  await settle();
  press(library, 'ArrowDown');
  await runtime.advance(300000);
  await settle();
  assert.equal(library.data.selectedId, 'two');
  assert.equal(library.data.bound, true);
  assert.equal(renewals, 1);
  library.onHide();
  const reader = await runtime.page('reader', { id: 'two' });
  await settle();
  press(reader, 'ArrowDown');
  await runtime.advance(86400000);
  await settle();
  assert.equal(reader.data.body, '第二段。');
  assert.equal(renewals, 2);
  assert.ok(runtime.timerQueue.size > 0, '续期成功后应重新安排下一次检查');
});

test('解绑遇到过期访问凭据会续期后撤销，临时续期失败保留账号', async () => {
  let offline = true;
  let revoked = false;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (href.endsWith('/refresh')) {
      if (offline) throw new Error('offline');
      return json(modernGrant({ access_token: 'revocable-access', confirmation_required: false }));
    }
    assert.equal(options.method, 'DELETE');
    if (options.headers.Authorization !== 'Bearer revocable-access') return json({ error: 'invalid_token' }, 401);
    revoked = true;
    return new Response(null, { status: 204 });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const binding = renewable();
  zhisheng.saveBinding(binding);
  await assert.rejects(zhisheng.revokeBinding(binding), { code: 'network' });
  assert.equal(zhisheng.getBinding().refreshToken, binding.refreshToken);
  assert.equal(revoked, false);
  offline = false;
  await zhisheng.revokeBinding(binding);
  assert.equal(revoked, true);
  assert.equal(zhisheng.getBinding(), null);
});

test('音频下载期间同一绑定续期仍可播放，切换账号的旧下载被丢弃', async () => {
  let response = deferred();
  let downloads = 0;
  const audioBytes = Uint8Array.from([0xff, 0xf3, 0x84, 0xc0]);
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (href.endsWith('/refresh')) return json(modernGrant({ access_token: 'rotated-access', confirmation_required: false }));
    if (href.includes('/audio-ticket')) return json({ url: `${origin}/v1/zhiyue/media/private-ticket`, expires_in: 150 });
    if (href.includes('/media/')) {
      downloads += 1;
      return { status: 206, headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-3/4' }),
        arrayBuffer: () => response.promise };
    }
    assert.equal(options.method, 'DELETE');
    return new Response(null, { status: 204 });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const audio = zhisheng.getAudioBuffer('release');
  await settle();
  await zhisheng.ensureBinding(true);
  response.resolve(audioBytes.buffer);
  assert.equal((await audio).byteLength, 4);
  await zhisheng.getAudioBuffer('release');
  assert.equal(downloads, 1);
  response = deferred();
  const staleAudio = assert.rejects(zhisheng.getAudioBuffer('another-release'), { code: 'auth_required' });
  await settle();
  await zhisheng.revokeBinding(zhisheng.getBinding());
  zhisheng.saveBinding(renewable({ token: 'another-token', bindingId: 'another-binding',
    refreshToken: 'another-refresh', account: { id: 'another-account', displayName: '' } }));
  response.resolve(audioBytes.buffer);
  await staleAudio;
});

test('联网恢复后自动重试确认和过期续期，隐藏页面停止重试', async () => {
  let offline = true;
  let confirms = 0;
  let refreshes = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/confirm')) {
      confirms += 1;
      if (offline) throw new Error('offline');
      return new Response(null, { status: 204 });
    }
    if (href.endsWith('/refresh')) {
      refreshes += 1;
      if (offline) return json({ error: 'temporarily_unavailable' }, 503);
      return json(modernGrant({ access_token: `retry-access-${refreshes}`, confirmation_required: false }));
    }
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const pair = await runtime.page('pair');
  await settle();
  pair.onHide();
  await runtime.advance(10000);
  assert.equal(confirms, 1);
  offline = false;
  pair.onShow();
  await settle();
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  offline = true;
  await runtime.advance(86400000);
  const library = await runtime.page('index');
  await settle();
  assert.equal(library.data.canRetry, true);
  assert.equal(zhisheng.getBinding().refreshToken, 'fictional-refresh');
  offline = false;
  await runtime.advance(1000);
  await settle();
  assert.equal(library.data.canRetry, false);
  assert.equal(library.data.bound, true);
  assert.equal(refreshes, 2);
});

test('确认过程中关闭页面仍保存结果，不迟到导航，也不再次占用设备绑定', async () => {
  const confirmation = deferred();
  let confirms = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    assert.ok(href.endsWith('/confirm'));
    confirms += 1;
    return confirmation.promise;
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable({ confirmationRequired: true }));
  const pair = await runtime.page('pair');
  pair.onUnload();
  confirmation.resolve(new Response(null, { status: 204 }));
  await settle();
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  assert.equal(runtime.navigation.length, 0);
  assert.equal(confirms, 1);
});

test('演示模式保留文章、分页及本地音频', async () => {
  const runtime = createRuntime({ base: null });
  const appConfig = JSON.parse(readFileSync(new URL('app.json', appRoot), 'utf8'));
  for (const route of appConfig.pages) await runtime.load(`${route}.ink`);
  const library = await runtime.page('index');
  const { articles } = await runtime.load('data/articles.js');
  for (const article of articles) {
    assert.equal(library.data.selectedId, article.id);
    if (article.audio) assert.equal(readFileSync(new URL(`.${article.audio}`, appRoot)).subarray(0, 4).toString(), 'OggS');
    press(library, 'ArrowDown');
  }
  const reader = await runtime.page('reader', { id: articles[0].id });
  press(reader, 'Enter');
  const player = runtime.players[0];
  assert.equal(player.src, articles[0].audio);
  player.callbacks.ready();
  press(reader, 'ArrowDown');
  assert.equal(reader.data.pageIndex, 1);
  assert.equal(reader.data.audioLabel, '暂停');
  press(reader, 'Backspace');
  assert.equal(player.destroyed, true);
});

test('手机配对轮询、读取全部文章及点击后申请单篇音频票据', async () => {
  const calls = [];
  let polls = 0;
  let audioTickets = 0;
  const audioBytes = Uint8Array.from([0xff, 0xf3, 0x84, 0xc0, 0, 1, 2, 3]);
  const download = deferred();
  const runtime = createRuntime({ request: async (href, options) => {
    const url = new URL(href);
    const path = url.pathname.replace('/v1/zhiyue', '');
    calls.push(path);
    if (path === '/device/authorize') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {});
      return json({ device_code: 'opaque-code', user_code: 'ABCD-EFGH', verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    }
    if (path === '/device/token') {
      assert.deepEqual(JSON.parse(options.body), { device_code: 'opaque-code' });
      polls += 1;
      if (polls === 1) return json({ error: 'authorization_pending' }, 400);
      if (polls === 2) return json({ error: 'slow_down' }, 429, { 'Retry-After': '20' });
      return json(session);
    }
    if (path === '/media/ticket-1') {
      assert.equal(options.headers.Range, 'bytes=0-8388607');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return {
        status: 206, headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-7/8' }),
        arrayBuffer: () => download.promise,
      };
    }
    if (path === '/media/ticket-4') return json({ error: 'invalid_token' }, 401);
    assert.equal(options.headers.Authorization, `Bearer ${session.access_token}`);
    if (path === '/read/articles') {
      const offset = Number(url.searchParams.get('offset'));
      assert.equal(url.searchParams.get('limit'), '12');
      return json({
        total: 15, offset, limit: 12,
        items: Array.from({ length: Math.min(12, 15 - offset) }, (_, i) => ({
          id: `article-${i + offset}`, title: `文章 ${i + offset}`, publishedAt: '2026-11-08', hasAudio: true,
        })),
      });
    }
    if (path === '/read/articles/article-14') return json({
      id: 'article-14', releaseId: 'release-14', title: '文章 14', publishedAt: '2026-11-08', hasAudio: true,
      text: '简体中文和日本語。\r\n下一段。',
    });
    if (path === '/read/releases/release-14/audio-ticket') {
      audioTickets += 1;
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), {});
      return json({ url: `${origin}/v1/zhiyue/media/ticket-${audioTickets}`, expires_in: 60 });
    }
    assert.fail('未预期的请求路径');
  } });
  const library = await runtime.page('index');
  press(library, 'Enter');
  assert.equal(runtime.navigation.at(-1), '/pages/pair/index');
  const pair = await runtime.page('pair');
  await pair.startPairing();
  assert.equal(pair.data.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(pair.data).includes('opaque-code'), false);
  await runtime.advance(5000);
  await runtime.advance(5000);
  pair.onHide();
  await runtime.advance(15000);
  assert.equal(polls, 2);
  pair.onShow();
  await runtime.advance(5000);
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 1);
  const saved = JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`));
  assert.deepEqual(Object.keys(saved).sort(), ['account', 'bindingId', 'expiresAt', 'token']);

  library.onShow();
  await settle();
  assert.equal(library.data.countLabel, '1 / 15');
  for (let i = 1; i < 15; i += 1) {
    press(library, 'ArrowDown');
    await settle();
    assert.equal(library.data.selectedId, `article-${i}`);
  }
  assert.equal(calls.filter((path) => path === '/read/articles').length, 2);
  press(library, 'Enter');
  assert.equal(runtime.navigation.at(-1), '/pages/reader/index?id=article-14');
  library.onHide();
  const reader = await runtime.page('reader', { id: 'article-14' });
  await settle();
  assert.equal(reader.data.body, '简体中文和日本語。');
  assert.equal(audioTickets, 0);
  press(reader, 'Enter');
  await settle();
  await runtime.advance(8001);
  assert.equal(reader.data.audioLabel, '载入中 · 取消');
  assert.equal(runtime.players.length, 0);
  download.resolve(audioBytes.buffer);
  await settle();
  const player = runtime.players.at(-1);
  assert.equal(player.src, undefined);
  assert.equal(player.buffer, audioBytes.buffer);
  assert.equal(player.hint, 'audio/mpeg');
  assert.equal(player.plays, undefined);
  player.callbacks.ready();
  player.callbacks.ready();
  assert.equal(player.plays, 1);
  assert.equal(reader.data.audioLabel, '暂停');
  press(reader, 'Enter');
  assert.equal(reader.data.audioLabel, '继续播放');
  press(reader, 'Enter');
  assert.equal(player.plays, 2);
  assert.equal(audioTickets, 1);
  press(reader, 'ArrowDown');
  assert.equal(reader.data.body, '下一段。');
  player.callbacks.end();
  assert.equal(player.destroyed, true);
  press(reader, 'Enter');
  await settle();
  assert.equal(audioTickets, 2);
  assert.equal(calls.filter((path) => path.startsWith('/media/')).length, 1);
  const replay = runtime.players.at(-1);
  assert.notEqual(replay.buffer, player.buffer);
  assert.deepEqual(new Uint8Array(replay.buffer), audioBytes);
  replay.callbacks.ready();
  assert.equal(reader.data.audioLabel, '暂停');
  press(reader, 'Backspace');
  assert.equal(replay.destroyed, true);
  reader.onUnload();

  const reopened = await runtime.page('reader', { id: 'article-14' });
  await settle();
  press(reopened, 'Enter');
  await settle();
  assert.equal(audioTickets, 3);
  assert.equal(calls.filter((path) => path.startsWith('/media/')).length, 1);
  const reopenedPlayer = runtime.players.at(-1);
  assert.deepEqual(new Uint8Array(reopenedPlayer.buffer), audioBytes);
  reopenedPlayer.callbacks.error();
  press(reopened, 'Enter');
  await settle();
  assert.equal(reopened.data.audioLabel, '音频 HTTP 401 · 重试');
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 1);
  assert.equal(runtime.players.length, 3);
  press(reopened, 'Backspace');
  assert.equal(JSON.stringify([...runtime.storage.values()]).includes('ticket-1'), false);
  reopened.onUnload();
});

test('缓存按最近使用淘汰且受总大小限制，换绑或撤稿后不复用旧音频', async () => {
  const downloads = [];
  const tickets = [];
  let responseStatus = 200;
  const runtime = createRuntime({ request: async (href, options) => {
    const path = new URL(href).pathname;
    if (path.endsWith('/audio-ticket')) {
      const release = path.split('/').at(-2);
      tickets.push(release);
      if (responseStatus !== 200) return json({}, responseStatus);
      return json({ url: `${origin}/v1/zhiyue/media/${release}`, expires_in: 150 });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const release = path.split('/').at(-1);
    downloads.push(release);
    const size = release === 'full' ? 4 * 1024 * 1024 : release === 'oversized' ? 4 * 1024 * 1024 + 1 : 4;
    return {
      status: 200, headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(size) }),
      arrayBuffer: async () => new ArrayBuffer(size),
    };
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const binding = { token: 'read-token', expiresAt: 1_800_000_000_000 + 60000,
    bindingId: 'binding-1', account: { id: '1', displayName: '' } };
  zhisheng.saveBinding(binding);
  for (const release of ['a', 'b', 'c', 'a', 'd', 'a', 'b']) {
    await zhisheng.getAudioBuffer(release);
  }
  assert.deepEqual(tickets, ['a', 'b', 'c', 'a', 'd', 'a', 'b']);
  assert.deepEqual(downloads, ['a', 'b', 'c', 'd', 'b']);
  const full = await zhisheng.getAudioBuffer('full');
  new Uint8Array(full)[0] = 42;
  await zhisheng.getAudioBuffer('oversized');
  const fullReplay = await zhisheng.getAudioBuffer('full');
  assert.equal(new Uint8Array(fullReplay)[0], 0);
  await zhisheng.getAudioBuffer('oversized');
  await zhisheng.getAudioBuffer('a');
  assert.deepEqual(downloads.slice(-4), ['full', 'oversized', 'oversized', 'a']);

  responseStatus = 404;
  await assert.rejects(zhisheng.getAudioBuffer('a'), { code: 'not_found' });
  responseStatus = 200;
  await zhisheng.getAudioBuffer('a');
  assert.deepEqual(downloads.slice(-2), ['a', 'a']);

  responseStatus = 401;
  await assert.rejects(zhisheng.getAudioBuffer('a'), { code: 'auth_required' });
  assert.equal(zhisheng.getBinding(), null);
  responseStatus = 200;
  zhisheng.saveBinding({ ...binding, token: 'new-token', bindingId: 'binding-2' });
  await zhisheng.getAudioBuffer('a');
  assert.deepEqual(downloads.slice(-3), ['a', 'a', 'a']);
  assert.equal(JSON.stringify([...runtime.storage.values()]).includes('oversized'), false);
});

test('撤销失败保留原账号，过时 401 不会清除新账号', async () => {
  const oldResponse = deferred();
  let failRevoke = true;
  let activeResponse = oldResponse.promise;
  const runtime = createRuntime({ request: async (href, options) => {
    if (options.method === 'DELETE') {
      if (failRevoke) throw new Error('offline');
      return new Response(null, { status: 204 });
    }
    assert.ok(href.includes('/read/articles?'));
    return activeResponse;
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const original = {
    token: 'original', expiresAt: 1_800_000_000_000 + 60000,
    bindingId: 'binding-1', account: { id: '1', displayName: '旧账号' },
  };
  const next = { ...original, token: 'replacement', bindingId: 'binding-2' };
  zhisheng.saveBinding(original);
  await assert.rejects(zhisheng.revokeBinding(original), { code: 'network' });
  assert.equal(zhisheng.getBinding().token, original.token);
  const stale = assert.rejects(zhisheng.listArticles(0), { code: 'auth_required' });
  failRevoke = false;
  await zhisheng.revokeBinding(original);
  zhisheng.saveBinding(next);
  oldResponse.resolve(new Response(null, { status: 401 }));
  await stale;
  assert.equal(zhisheng.getBinding().token, next.token);
  activeResponse = Promise.resolve(new Response(null, { status: 401 }));
  await assert.rejects(zhisheng.listArticles(0), { code: 'auth_required' });
  assert.equal(zhisheng.getBinding(), null);
});

test('取消播放时丢弃迟到票据，授权过期清空阅读状态', async () => {
  const lateTicket = deferred();
  let audioSignal;
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/audio-ticket')) {
      audioSignal = options.signal;
      return lateTicket.promise;
    }
    return json({ id: 'one', releaseId: 'release', title: '标题', publishedAt: '2026-11-08', hasAudio: true, text: '正文。' });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'short-token', expiresAt: 1_800_000_000_000 + 1000,
    bindingId: 'binding', account: { id: '1', displayName: '' } });
  const reader = await runtime.page('reader', { id: 'one' });
  await settle();
  press(reader, 'Enter');
  await settle();
  press(reader, 'Enter');
  assert.equal(audioSignal.aborted, true);
  lateTicket.resolve(json({ url: `${origin}/v1/zhiyue/media/late`, expires_in: 60 }));
  await settle();
  assert.equal(runtime.players.length, 0);
  await runtime.advance(1000);
  assert.equal(reader.data.hasBody, false);
  assert.match(reader.data.body, /授权已失效/);
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 0);
});

test('下载超时和返回列表都会取消音频响应体，迟到的字节不会播放或写入缓存', async () => {
  let body = deferred();
  let mediaSignal;
  let downloads = 0;
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/audio-ticket')) {
      return json({ url: `${origin}/v1/zhiyue/media/delayed`, expires_in: 150 });
    }
    if (href.includes('/media/')) {
      downloads += 1;
      mediaSignal = options.signal;
      return {
        status: 200, headers: new Headers({ 'Content-Type': 'audio/mpeg', 'Content-Length': '4' }),
        arrayBuffer: () => body.promise,
      };
    }
    return json({ id: 'one', releaseId: 'release', title: '标题', publishedAt: '2026-11-08', hasAudio: true, text: '正文。' });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'read-token', expiresAt: 1_800_000_000_000 + 200000,
    bindingId: 'binding', account: { id: '1', displayName: '' } });
  const reader = await runtime.page('reader', { id: 'one' });
  await settle();
  press(reader, 'Enter');
  await settle();
  await runtime.advance(90000);
  assert.equal(mediaSignal.aborted, true);
  assert.equal(reader.data.audioLabel, '音频下载超时 · 重试');
  body.resolve(new ArrayBuffer(4));
  await settle();
  assert.equal(runtime.players.length, 0);
  body = deferred();
  press(reader, 'Enter');
  await settle();
  assert.equal(mediaSignal.aborted, false);
  assert.equal(downloads, 2);
  press(reader, 'Backspace');
  assert.equal(mediaSignal.aborted, true);
  body.resolve(new ArrayBuffer(4));
  await settle();
  assert.equal(runtime.players.length, 0);
});

test('恢复时重新授权后才显示列表和正文，并保留原位置', async () => {
  const items = [
    { id: 'one', title: '第一篇', publishedAt: '2026-11-08', hasAudio: false },
    { id: 'two', title: '第二篇', publishedAt: '2026-11-07', hasAudio: false },
  ];
  const list = () => json({ items, offset: 0, limit: 12, total: 2 });
  const detail = () => json({ ...items[1], releaseId: 'fixed-release', text: '第一段。\n第二段。' });
  let listResponse = list();
  let detailResponse = detail();
  let listCalls = 0;
  let detailCalls = 0;
  const runtime = createRuntime({ request: async (href, options) => {
    assert.equal(options.headers.Authorization, 'Bearer read-token');
    if (href.includes('/read/articles?')) {
      listCalls += 1;
      return listResponse;
    }
    assert.ok(href.endsWith('/read/articles/two'));
    detailCalls += 1;
    return detailResponse;
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'read-token', expiresAt: 1_800_000_000_000 + 60000,
    bindingId: 'binding', account: { id: '1', displayName: '' } });

  const library = await runtime.page('index');
  await settle();
  press(library, 'ArrowDown');
  assert.equal(library.data.selectedId, 'two');
  library.onHide();
  assert.equal(library.data.rows.length, 0);
  const listRefresh = deferred();
  listResponse = listRefresh.promise;
  library.onShow();
  library.onShow();
  assert.equal(library.data.rows.length, 0);
  await settle();
  assert.equal(listCalls, 2);
  listRefresh.resolve(list());
  await settle();
  assert.equal(library.data.selectedId, 'two');
  library.onHide();

  const reader = await runtime.page('reader', { id: 'two' });
  await settle();
  press(reader, 'ArrowDown');
  assert.equal(reader.data.body, '第二段。');
  reader.onHide();
  assert.equal(reader.data.body, '');
  const detailRefresh = deferred();
  detailResponse = detailRefresh.promise;
  reader.onShow();
  reader.onShow();
  assert.equal(reader.data.hasBody, false);
  await settle();
  assert.equal(detailCalls, 2);
  detailRefresh.resolve(detail());
  await settle();
  assert.equal(reader.data.body, '第二段。');
  reader.onHide();

  detailResponse = new Response(null, { status: 401 });
  reader.onShow();
  assert.equal(reader.data.hasBody, false);
  await settle();
  assert.match(reader.data.body, /授权已失效/);
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 0);
  library.onShow();
  assert.equal(library.data.rows.length, 0);
  assert.equal(library.data.bound, false);
});

// 保留 main 的设备授权回归，按统一协议字段与恢复规则整合。
const renewalSession = { ...session, confirmation_required: false };

test('renewable binding survives long idle periods and concurrent renewal uses one request', async () => {
  let renewals = 0;
  let reads = 0;
  const pending = deferred();
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/refresh')) {
      renewals++;
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'stable-refresh' });
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      if (renewals === 1) await pending.promise;
      return json({ ...renewalSession, access_token: `access-${renewals}`, refresh_token: 'stable-refresh' });
    }
    reads++;
    assert.equal(options.headers.Authorization, `Bearer access-${renewals}`);
    return json({ items: [], total: 0, limit: 12, offset: 0 });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'old-access', refreshToken: 'stable-refresh', expiresAt: 1_800_000_001_000,
    bindingId: session.binding_id, account: session.account });
  await runtime.advance(365 * 86400000);
  assert.ok(zhisheng.getBinding());
  const a = zhisheng.listArticles(0);
  const b = zhisheng.listArticles(0);
  await settle();
  assert.equal(renewals, 1);
  pending.resolve();
  await Promise.all([a, b]);
  assert.equal(reads, 2);
  for (let i = 0; i < 3; i++) {
    await runtime.advance(86400001);
    await zhisheng.listArticles(0);
  }
  assert.equal(renewals, 4);
  assert.equal(zhisheng.getBinding().refreshToken, 'stable-refresh');
});

test('legacy upgrade is automatic, persists credentials, and rejects changed identity', async () => {
  let mismatch = false;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    assert.ok(href.endsWith('/device/upgrade'));
    assert.equal(options.headers.Authorization, 'Bearer legacy');
    return json({ ...renewalSession, binding_id: mismatch ? 'wrong-binding' : session.binding_id,
      refresh_token: 'stable-refresh' });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const binding = { token: 'legacy', expiresAt: 1_800_000_060_000,
    bindingId: session.binding_id, account: session.account };
  zhisheng.saveBinding(binding);
  mismatch = true;
  await assert.rejects(zhisheng.ensureBinding(), { code: 'bad_response' });
  assert.equal(zhisheng.getBinding().token, 'legacy');
  mismatch = false;
  await zhisheng.ensureBinding();
  assert.equal(zhisheng.getBinding().refreshToken, 'stable-refresh');
});

test('transient renewal failure retains binding while permanent revocation clears it', async () => {
  let failure = 'network';
  const runtime = createRuntime({ request: async () => {
    if (failure === 'network') throw new Error('offline');
    return json({ error: 'invalid_grant' }, 400);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'old', refreshToken: 'refresh', expiresAt: 1_800_000_001_000,
    bindingId: session.binding_id, account: session.account });
  await runtime.advance(86400000);
  await assert.rejects(zhisheng.listArticles(0), { code: 'network' });
  assert.equal(zhisheng.getBinding().refreshToken, 'refresh');
  failure = 'revoked';
  await assert.rejects(zhisheng.listArticles(0), { code: 'auth_required' });
  assert.equal(zhisheng.getBinding(), null);
});

test('重复 401 最多续期一次，并保留尚未明确撤销的可恢复绑定', async () => {
  let renewals = 0;
  let reads = 0;
  const runtime = createRuntime({ request: async (href) => {
    if (href.endsWith('/device/refresh')) {
      renewals++;
      return json({ ...renewalSession, access_token: 'replacement', refresh_token: 'refresh' });
    }
    reads++;
    return json({ error: 'invalid_token' }, 401);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'old', refreshToken: 'refresh', expiresAt: 1_800_086_400_000,
    bindingId: session.binding_id, account: session.account });
  await assert.rejects(zhisheng.listArticles(0), { code: 'service' });
  assert.equal(renewals, 1);
  assert.equal(reads, 2);
  assert.equal(zhisheng.getBinding().refreshToken, 'refresh');
});

test('failed credential persistence is retryable and a fresh client restores expired access', async () => {
  const runtime = createRuntime();
  const { createZhishengClient } = await runtime.load('lib/zhisheng.js');
  let stored = null;
  let failWrite = false;
  let clock = 1_800_000_000_000;
  let count = 0;
  const identityStorage = new Map();
  const storage = {
    getItem: (key) => key.startsWith('zhiyue.device.') ? identityStorage.get(key) ?? null : stored,
    setItem: (key, value) => {
      if (key.startsWith('zhiyue.device.')) { identityStorage.set(key, value); return; }
      if (failWrite) throw new Error('disk'); stored = value;
    },
    removeItem: () => { stored = null; },
  };
  const request = async (href) => {
    assert.ok(href.endsWith('/device/refresh'));
    count++;
    return json({ ...renewalSession, access_token: `replacement-${count}`, refresh_token: 'refresh' });
  };
  const options = { origin, storage, request, now: () => clock };
  const client = createZhishengClient(options);
  client.saveBinding({ token: 'old', refreshToken: 'refresh', expiresAt: clock + 1000,
    bindingId: session.binding_id, account: session.account });
  clock += 86400000;
  failWrite = true;
  await assert.rejects(client.ensureBinding(), { code: 'storage' });
  assert.equal(JSON.parse(stored).token, 'old');
  failWrite = false;
  const restarted = createZhishengClient(options);
  await restarted.ensureBinding();
  assert.equal(restarted.getBinding().token, 'replacement-2');
  assert.equal(restarted.getBinding().refreshToken, 'refresh');
});

test('new unstored grants are revoked after failed save without deleting another stored account', async () => {
  const revoked = [];
  const runtime = createRuntime({ request: async (_href, options) => {
    assert.equal(options.method, 'DELETE');
    revoked.push(options.headers.Authorization);
    return new Response(null, { status: 204 });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const grant = { token: 'unstored', refreshToken: 'refresh', expiresAt: 1_800_000_060_000,
    bindingId: 'unsaved-binding', account: session.account };
  await zhisheng.revokeBinding(grant);
  assert.deepEqual(revoked, ['Bearer unstored']);
  zhisheng.saveBinding({ ...grant, token: 'existing', bindingId: 'existing-binding' });
  assert.throws(() => zhisheng.saveBinding(grant), { code: 'binding_exists' });
  await zhisheng.revokeBinding(grant);
  assert.deepEqual(revoked, ['Bearer unstored', 'Bearer unstored']);
  assert.equal(zhisheng.getBinding().token, 'existing');
});

test('leaving pairing during claim revokes the late unstored grant', async () => {
  const claim = deferred();
  const revoked = [];
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/authorize')) return json({ device_code: 'code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    if (href.endsWith('/device/token')) return claim.promise;
    assert.equal(options.method, 'DELETE');
    revoked.push(options.headers.Authorization);
    return new Response(null, { status: 204 });
  } });
  const pair = await runtime.page('pair');
  await pair.startPairing();
  const poll = runtime.advance(5000);
  await settle();
  pair.onUnload();
  claim.resolve(json({ ...renewalSession, refresh_token: 'refresh' }));
  await poll;
  assert.deepEqual(revoked, [`Bearer ${session.access_token}`]);
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 0);
});

function pendingGrant() {
  return { ...renewalSession, refresh_token: 'pending-refresh', confirmation_required: true };
}

test('initial confirmation waits for reliable persistence and is single-flight before any read', async () => {
  const wait = deferred();
  let confirms = 0;
  let reads = 0;
  let client;
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    if (href.endsWith('/device/confirm')) {
      confirms++;
      assert.equal(client.getBinding().confirmationRequired, true);
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'pending-refresh' });
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      await wait.promise;
      return new Response(null, { status: 204 });
    }
    reads++;
    assert.equal(client.getBinding().confirmationRequired, false);
    return json({ items: [], offset: 0, limit: 12, total: 0 });
  } });
  client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  const binding = await client.exchangeDeviceCode('code');
  assert.equal(binding.confirmationRequired, true);
  assert.equal(confirms, 0);
  client.saveBinding(binding);
  const a = client.listArticles(0);
  const b = client.listArticles(0);
  await settle();
  assert.equal(confirms, 1);
  assert.equal(reads, 0);
  wait.resolve();
  await Promise.all([a, b]);
  assert.equal(reads, 2);
});

test('lost confirmation response and failed marker save survive restart and retry idempotently', async () => {
  const runtime = createRuntime();
  const { createZhishengClient } = await runtime.load('lib/zhisheng.js');
  let raw = null;
  let failSave = false;
  let confirms = 0;
  const identityStorage = new Map();
  const storage = {
    getItem: (key) => key.startsWith('zhiyue.device.') ? identityStorage.get(key) ?? null : raw,
    setItem: (key, value) => {
      if (key.startsWith('zhiyue.device.')) { identityStorage.set(key, value); return; }
      if (failSave) throw new Error('disk'); raw = value;
    },
    removeItem: () => { raw = null; },
  };
  const request = async (href) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    assert.ok(href.endsWith('/device/confirm'));
    confirms++;
    if (confirms === 1) throw new Error('response lost after server commit');
    return new Response(null, { status: 204 });
  };
  const options = { origin, storage, request, now: () => 1_800_000_000_000 };
  let client = createZhishengClient(options);
  const grant = await client.exchangeDeviceCode('code');
  failSave = true;
  assert.throws(() => client.saveBinding(grant), { code: 'storage' });
  assert.equal(confirms, 0);
  assert.equal(raw, null);
  failSave = false;
  client.saveBinding(grant);
  await assert.rejects(client.ensureBinding(), { code: 'network' });
  assert.equal(JSON.parse(raw).confirmationRequired, true);
  client = createZhishengClient(options);
  failSave = true;
  await assert.rejects(client.ensureBinding(), { code: 'storage' });
  assert.equal(JSON.parse(raw).confirmationRequired, true);
  failSave = false;
  client = createZhishengClient(options);
  await client.ensureBinding();
  assert.equal(confirms, 3);
  assert.equal(client.getBinding().confirmationRequired, false);
});

test('confirmation deadline or revocation permanently clears pending binding without reading', async () => {
  let confirms = 0;
  const runtime = createRuntime({ request: async (href) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    assert.ok(href.endsWith('/device/confirm'));
    confirms++;
    return json({ error: 'invalid_grant' }, 400);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(await zhisheng.exchangeDeviceCode('code'));
  await runtime.advance(300001);
  await assert.rejects(zhisheng.listArticles(0), { code: 'auth_required' });
  assert.equal(confirms, 1);
  assert.equal(zhisheng.getBinding(), null);
});

test('cancelled confirmation cannot restore the locally revoked binding', async () => {
  const confirm = deferred();
  let revoked = 0;
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    if (href.endsWith('/device/confirm')) return confirm.promise;
    assert.equal(options.method, 'DELETE');
    revoked++;
    return new Response(null, { status: 204 });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const binding = await zhisheng.exchangeDeviceCode('code');
  zhisheng.saveBinding(binding);
  const pending = assert.rejects(zhisheng.ensureBinding(), { code: 'auth_required' });
  await settle();
  await zhisheng.revokeBinding(binding);
  confirm.resolve(new Response(null, { status: 204 }));
  await pending;
  assert.equal(revoked, 1);
  assert.equal(zhisheng.getBinding(), null);
});

test('expired legacy access retries an uncertain upgrade within the server recovery window', async () => {
  let upgrades = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    assert.ok(href.endsWith('/device/upgrade'));
    upgrades++;
    if (upgrades === 1) throw new Error('lost upgrade response');
    return json({ ...renewalSession, refresh_token: 'recovered', confirmation_required: false });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'legacy', expiresAt: 1_800_000_001_000,
    bindingId: session.binding_id, account: session.account });
  await assert.rejects(zhisheng.ensureBinding(), { code: 'network' });
  await runtime.advance(2000);
  assert.ok(zhisheng.getBinding());
  await zhisheng.ensureBinding();
  assert.equal(zhisheng.getBinding().refreshToken, 'recovered');
});

test('pairing preserves uncertain confirmation, retries, and returns only after confirmation', async () => {
  let confirms = 0;
  const runtime = createRuntime({ request: async (href) => {
    if (href.endsWith('/device/authorize')) return json({ device_code: 'code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    if (href.endsWith('/device/token')) return json(pendingGrant());
    assert.ok(href.endsWith('/device/confirm'));
    confirms++;
    if (confirms === 1) throw new Error('offline');
    return new Response(null, { status: 204 });
  } });
  const pair = await runtime.page('pair');
  await pair.startPairing();
  await runtime.advance(5000);
  assert.equal(runtime.navigation.length, 0);
  assert.equal(JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`)).confirmationRequired, true);
  assert.equal(pair.data.action, '继续绑定');
  await runtime.advance(5000);
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`)).confirmationRequired, false);
});

test('领取后确认过程中关闭页面保留已保存授权，并且不会迟到导航', async () => {
  const confirm = deferred();
  let revoked = 0;
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/authorize')) return json({ device_code: 'code', user_code: 'ABCD-EFGH',
      verification_uri: `${origin}/connections/zhiyue`, expires_in: 300, interval: 5 });
    if (href.endsWith('/device/token')) return json(pendingGrant());
    if (href.endsWith('/device/confirm')) return confirm.promise;
    assert.equal(options.method, 'DELETE');
    revoked++;
    return new Response(null, { status: 204 });
  } });
  const pair = await runtime.page('pair');
  await pair.startPairing();
  const polling = runtime.advance(5000);
  await settle();
  pair.onUnload();
  await settle();
  confirm.resolve(new Response(null, { status: 204 }));
  await polling;
  assert.equal(revoked, 0);
  assert.equal(Number(runtime.storage.has(`zhiyue.binding.v1:${origin}`)), 1);
  assert.equal(JSON.parse(runtime.storage.get(`zhiyue.binding.v1:${origin}`)).confirmationRequired, false);
  assert.equal(runtime.navigation.length, 0);
});

test('in-flight cancellation blocks a concurrent confirmation and reading until revocation completes', async () => {
  const confirm = deferred();
  const revoke = deferred();
  const runtime = createRuntime({ request: async (href, options) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    if (href.endsWith('/device/confirm')) return confirm.promise;
    assert.equal(options.method, 'DELETE');
    return revoke.promise;
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  const binding = await zhisheng.exchangeDeviceCode('code');
  zhisheng.saveBinding(binding);
  const pending = assert.rejects(zhisheng.ensureBinding(), { code: 'revoking' });
  await settle();
  const cancelling = zhisheng.revokeBinding(binding);
  await assert.rejects(zhisheng.listArticles(0), { code: 'revoking' });
  confirm.resolve(new Response(null, { status: 204 }));
  await pending;
  assert.equal(zhisheng.getBinding().confirmationRequired, true);
  revoke.resolve(new Response(null, { status: 204 }));
  await cancelling;
  assert.equal(zhisheng.getBinding(), null);
});

test('server rejection after the fixed legacy upgrade recovery window clears the local legacy grant', async () => {
  let upgrades = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    assert.ok(href.endsWith('/device/upgrade'));
    upgrades++;
    if (upgrades === 1) throw new Error('lost successful upgrade response');
    return json({ error: 'invalid_grant' }, 400);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'legacy', expiresAt: 1_800_000_001_000,
    bindingId: session.binding_id, account: session.account });
  await assert.rejects(zhisheng.ensureBinding(), { code: 'network' });
  await runtime.advance(300001);
  await assert.rejects(zhisheng.ensureBinding(), { code: 'auth_required' });
  assert.equal(zhisheng.getBinding(), null);
});

test('an already confirmed binding with a stale local pending marker recovers after access expiry', async () => {
  const calls = [];
  const runtime = createRuntime({ request: async (href) => {
    if (href.endsWith('/device/token')) return json(pendingGrant());
    if (href.endsWith('/device/confirm')) {
      calls.push('confirm');
      return new Response(null, { status: 204 });
    }
    assert.ok(href.endsWith('/device/refresh'));
    calls.push('refresh');
    return json({ ...renewalSession, access_token: 'new-access', refresh_token: 'pending-refresh', confirmation_required: false });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(await zhisheng.exchangeDeviceCode('code'));
  // 首次确认已在远端完成，但重启前没有收到确认响应。
  await runtime.advance(2 * 86400000);
  await zhisheng.ensureBinding();
  assert.deepEqual(calls, ['confirm', 'refresh']);
  assert.equal(zhisheng.getBinding().confirmationRequired, false);
  assert.equal(zhisheng.getBinding().token, 'new-access');
});


test('主动识别只提交最终文字，累计结果不重复，取消后忽略迟到事件', async () => {
  const sessions = [];
  class Recognition {
    constructor() { sessions.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
  }
  const runtime = createRuntime({ base: null, Recognition });
  const { createSpeechInput } = await runtime.load('lib/speech.js');
  const states = [], texts = [];
  const speech = createSpeechInput({ onState: (...args) => states.push(args), onText: (text) => texts.push(text) });
  speech.start(); speech.start();
  assert.equal(sessions.length, 1);
  const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
  sessions[0].onresult({ results: [result('查找', false)] });
  speech.stop();
  assert.equal(sessions[0].stopped, true);
  sessions[0].onresult({ results: [result('查找', true), result('第一班电车之前', true)] });
  sessions[0].onend();
  assert.deepEqual(texts, ['查找第一班电车之前']);
  assert.equal(runtime.timerQueue.size, 0);
  speech.start();
  speech.cancel();
  sessions[1].onresult({ results: [result('迟到的识别', true)] });
  sessions[1].onend();
  assert.equal(texts.length, 1);
  assert.equal(sessions[1].aborted, true);
  speech.start();
  sessions[2].onresult({ results: [result('文'.repeat(201), true)] });
  sessions[2].onend();
  assert.equal(texts.length, 1);
  assert.match(states.at(-1)[1], /内容较长/);
});

test('识别权限拒绝、无语音和停止超时均释放会话并允许重试', async () => {
  const sessions = [];
  class Recognition {
    constructor() { sessions.push(this); }
    start() {}
    stop() {}
    abort() { this.aborted = true; }
  }
  const runtime = createRuntime({ base: null, Recognition });
  const { createSpeechInput } = await runtime.load('lib/speech.js');
  const states = [];
  const speech = createSpeechInput({ onState: (...args) => states.push(args), onText: () => assert.fail('不应检索') });
  speech.start(); sessions[0].onerror({ error: 'not-allowed' });
  assert.match(states.at(-1)[1], /权限/);
  speech.start(); sessions[1].onend();
  assert.match(states.at(-1)[1], /没有听清/);
  speech.start(); await runtime.advance(15000); await runtime.advance(5000);
  assert.match(states.at(-1)[1], /超时/);
  assert.ok(sessions.every((item) => item.aborted));
  assert.equal(runtime.timerQueue.size, 0);
});

test('演示语音支持分类、多条列表、唯一文章打开及返回全部', async () => {
  const runtime = createRuntime({ base: null });
  const page = await runtime.page('index');
  assert.ok(press(page, 'ArrowUp'));
  assert.equal(page.data.searchSelected, true);
  await page.search('查看日常分类');
  assert.equal(page.data.rows.length, 3);
  assert.equal(page.data.searchActive, true);
  assert.equal(runtime.navigation.length, 0);
  page.select(3);
  assert.equal(page.data.selectedId, 'tea-at-dusk');
  page.openArticle(page.data.selectedId);
  assert.match(runtime.navigation.at(-1), /tea-at-dusk/);
  await page.search('查找文章第一班电车之前');
  assert.match(runtime.navigation.at(-1), /before-the-first-train/);
  page.showAll();
  assert.equal(page.data.heading, '全部文章');
  assert.equal(page.data.searchActive, false);
  assert.equal(page.data.rows.length, 3);
});

function searchPage(items, extra = {}) {
  return { items, total: items.length, offset: 0, limit: 12, filters: { q: '', category: '' },
    kind: 'article', label: '检索结果', resolvedBy: 'local', ...extra };
}
const voiceItem = (index) => ({ id: 'voice-' + index, title: '文章' + index, publishedAt: '2026-11-15', hasAudio: false });

test('真实检索唯一文章直接打开，分类分页和重新显示保持同一筛选', async () => {
  const requests = [];
  let category = false;
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    requests.push(href);
    if (href.endsWith('/read/search')) {
      assert.deepEqual(JSON.parse(options.body), { text: category ? '科技分类' : '文章0' });
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return json(category ? searchPage(Array.from({ length: 12 }, (_, i) => voiceItem(i)),
        { total: 13, kind: 'category', filters: { q: '', category: 'science' }, label: '科技' })
        : searchPage([voiceItem(0)]));
    }
    if (href.includes('offset=12')) {
      assert.match(href, /category=science/);
      return json({ items: [voiceItem(12)], total: 13, limit: 12, offset: 12 });
    }
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  await page.search('文章0');
  assert.match(runtime.navigation.at(-1), /voice-0/);
  category = true;
  await page.search('科技分类');
  assert.equal(page.data.heading, '科技');
  assert.equal(runtime.navigation.length, 1);
  page.select(12); await settle();
  assert.equal(page.data.selectedId, 'voice-12');
  page.onHide(); page.onShow(); await settle();
  assert.match(requests.at(-1), /offset=12&category=science/);
  assert.equal(page.data.heading, '科技');
});

test('隐藏或换账号后丢弃迟到检索，未知分类显示分类且换账号清除', async () => {
  const pending = deferred();
  let mode = 'pending';
  let reads = 0;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/read/search')) return mode === 'pending' ? pending.promise
      : json(searchPage([], { kind: 'category', noMatch: true, label: '未找到分类' }));
    reads++;
    return json({ items: [], total: 0, offset: 0, limit: 12, navigation: { categories: [], uncategorizedCount: 0 } });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  const work = page.search('迟到');
  page.onHide();
  pending.resolve(json(searchPage([voiceItem(1)])));
  await work;
  assert.equal(runtime.navigation.length, 0);
  assert.equal(page.data.rows.length, 0);
  page.onShow(); await settle();
  mode = 'unknown';
  await page.search('不存在分类');
  const previousReads = reads;
  page.onHide(); page.onShow(); await settle();
  assert.equal(reads, previousReads + 1);
  assert.equal(page.data.categoriesActive, true);
  assert.equal(page.data.heading, '全部分类');
  assert.equal(page.data.rows.length, 0);
  runtime.storage.clear();
  zhisheng.saveBinding(renewable({ bindingId: 'new-binding', account: { id: 'new-user', displayName: '新账号' } }));
  page.onShow(); await settle();
  assert.equal(page.data.searchActive, false);
  assert.equal(page.data.heading, '全部文章');
});

test('语义失败可以重试，旧服务明确提示更新，隐藏页面取消识别', async () => {
  let session, calls = 0;
  class Recognition { constructor() { session = this; } start() {} abort() { this.aborted = true; } }
  const runtime = createRuntime({ modern: true, Recognition, request: async (href) => {
    if (href.endsWith('/read/search')) {
      calls++;
      return calls === 1 ? json({ code: 'NOT_FOUND' }, 404) : json(searchPage([]));
    }
    return emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  await page.search('找文章');
  assert.match(page.data.message, /需更新/);
  assert.equal(page.data.canRetry, true);
  page.retry(); await settle();
  assert.equal(calls, 2);
  page.voiceSearch();
  page.onHide();
  assert.equal(session.aborted, true);
  assert.equal(page.data.voiceState, 'idle');
});

test('未知演示分类显示全部分类，选择后仅列该类文章；文章无匹配不回退分类', async () => {
  const runtime = createRuntime({ base: null });
  const page = await runtime.page('index');
  await page.search('查看不存在分类');
  assert.equal(page.data.heading, '全部分类');
  assert.equal(page.data.categoriesActive, true);
  assert.ok(page.data.rows.length > 0);
  assert.equal(runtime.navigation.length, 0);
  const selected = page.libraryPage.items[0];
  page.openArticle(selected.id);
  assert.equal(page.data.categoriesActive, false);
  assert.equal(page.data.heading, selected.title);
  assert.ok(page.libraryPage.items.every((item) => item.category.id === selected.id));
  assert.equal(runtime.navigation.length, 0);
  await page.search('查找文章绝不存在标题');
  assert.equal(page.data.categoriesActive, false);
  assert.equal(page.data.rows.length, 0);
});

const categoryNavigation = (count = 14) => ({
  categories: Array.from({ length: count }, (_, i) =>
    ({ id: 'category-' + i, name: '分类' + i, articleCount: i + 1 })),
  uncategorizedCount: 2,
});

test('未知分类取完整导航，跨屏选择精确分类并保持分页，不误开文章', async () => {
  const calls = [];
  const runtime = createRuntime({ modern: true, request: async (href) => {
    calls.push(href);
    if (href.endsWith('/read/search')) return json(searchPage([], { kind: 'category', noMatch: true }));
    const u = new URL(href), offset = Number(u.searchParams.get('offset'));
    if (u.searchParams.get('category') === 'category-13') {
      return json({ items: Array.from({ length: offset ? 1 : 12 }, (_, i) => voiceItem(offset + i)),
        total: 13, offset, limit: 12 });
    }
    return json({ items: [], total: 0, offset: 0, limit: 12, navigation: categoryNavigation() });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  await page.search('未知分类');
  assert.equal(page.libraryPage.total, 15);
  assert.equal(page.data.heading, '全部分类');
  const beforeSelect = calls.length;
  page.select(13);
  assert.equal(page.data.selectedId, 'category-13');
  assert.equal(calls.length, beforeSelect); // 分类导航自身不重复分页读取
  assert.equal(runtime.navigation.length, 0);
  press(page, 'Enter'); await settle();
  assert.equal(page.data.categoriesActive, false);
  assert.equal(page.data.heading, '分类13');
  assert.equal(page.data.selectedId, 'voice-0');
  assert.equal(runtime.navigation.length, 0);
  page.select(12); await settle();
  assert.match(calls.at(-1), /offset=12&category=category-13/);
  page.onHide(); page.onShow(); await settle();
  assert.match(calls.at(-1), /offset=12&category=category-13/);
  page.showAll(); await settle();
  assert.equal(page.data.categoriesActive, false);
  assert.equal(page.data.searchActive, false);
  assert.doesNotMatch(calls.at(-1), /category=/);
});

test('分类导航缺失和失败不能用首屏冒充全部分类，重试可恢复', async () => {
  let available = false;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/read/search')) return json(searchPage([], { kind: 'category', noMatch: true }));
    return json({ items: [], total: 0, offset: 0, limit: 12,
      ...(available ? { navigation: categoryNavigation(1) } : {}) });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  await page.search('未知分类');
  assert.equal(page.data.canRetry, true);
  assert.equal(page.data.rows.length, 0);
  available = true;
  page.retry(); await settle();
  assert.equal(page.data.canRetry, false);
  assert.equal(page.data.categoriesActive, true);
  assert.equal(page.libraryPage.total, 2);
  page.select(1);
  assert.equal(page.data.selectedId, 'uncategorized');
});

test('分类导航加载期间退出或新检索会丢弃迟到分类结果', async () => {
  let pendingNavigation = false;
  const pending = deferred();
  const runtime = createRuntime({ modern: true, request: async (href, options) => {
    if (href.endsWith('/read/search')) return JSON.parse(options.body).text === '未知分类'
      ? json(searchPage([], { kind: 'category', noMatch: true }))
      : json(searchPage([]));
    return pendingNavigation ? pending.promise : emptyLibrary();
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  pendingNavigation = true;
  const work = page.search('未知分类'); await settle();
  await page.search('没有匹配文章');
  pending.resolve(json({ items: [], total: 0, offset: 0, limit: 12, navigation: categoryNavigation() }));
  await work;
  assert.equal(page.data.categoriesActive, false);
  assert.equal(page.data.heading, '检索结果');
  assert.equal(page.data.rows.length, 0);
});

test('首次分类检索等待或失败时可返回全部，迟到响应不能覆盖列表', async () => {
  for (const phase of ['search', 'navigation', 'failure']) {
    let searching = false;
    const pending = deferred();
    const runtime = createRuntime({ modern: true, request: async (href) => {
      if (href.endsWith('/read/search')) return phase === 'search' ? pending.promise
        : json(searchPage([], { kind: 'category', noMatch: true }));
      if (searching) {
        if (phase === 'failure') throw new Error('network failed');
        return pending.promise;
      }
      return json({ items: [voiceItem(0)], total: 1, offset: 0, limit: 12 });
    } });
    const { zhisheng } = await runtime.load('lib/zhisheng.js');
    zhisheng.saveBinding(renewable());
    const page = await runtime.page('index'); await settle();
    searching = true;
    const work = page.search('未知分类'); await settle();
    assert.equal(page.data.searchActive, true);
    assert.equal(phase === 'failure' ? page.data.canRetry : page.data.loading, true);
    searching = false;
    assert.equal(press(page, phase === 'navigation' ? 'Backspace' : 'Escape'), true, phase);
    await settle();
    assert.equal(page.searchQuery, '');
    assert.equal(page.data.heading, '全部文章');
    assert.equal(page.data.selectedId, 'voice-0');
    pending.resolve(phase === 'search' ? json(searchPage([], { kind: 'category', noMatch: true }))
      : json({ items: [], total: 0, offset: 0, limit: 12, navigation: categoryNavigation() }));
    await work;
    assert.equal(page.data.categoriesActive, false);
    assert.equal(page.data.searchActive, false);
    assert.equal(page.data.loading, false);
    assert.equal(page.data.canRetry, false);
    assert.equal(page.data.selectedId, 'voice-0');
    assert.equal(runtime.navigation.length, 0);
  }
});

test('分类导航参数校验、去重和空分类显示边界', async () => {
  const runtime = createRuntime({ base: null });
  const { categoryPage } = await runtime.load('lib/search.js');
  assert.throws(() => categoryPage({ categories: [], uncategorizedCount: -1 }));
  assert.throws(() => categoryPage({ categories: [{ id: 'x', name: 'x', articleCount: '1' }], uncategorizedCount: 0 }));
  const result = categoryPage({ categories: [
    { id: 'x', name: 'x', articleCount: 1 }, { id: 'x', name: 'x', articleCount: 1 },
    { id: 'y', name: 'y', articleCount: 0 }], uncategorizedCount: 0 });
  assert.equal(result.total, 1);
  assert.equal(categoryPage({ categories: [], uncategorizedCount: 0 }).total, 0);
});

test('分类切换加载失败后方向键不暴露旧分类，重试恢复选定分类文章', async () => {
  let available = false;
  const runtime = createRuntime({ modern: true, request: async (href) => {
    if (href.endsWith('/read/search')) return json(searchPage([], { kind: 'category', noMatch: true }));
    if (new URL(href).searchParams.get('category') === 'category-0') {
      if (!available) throw new Error('network failed');
      return json({ items: [voiceItem(0)], total: 1, offset: 0, limit: 12 });
    }
    return json({ items: [], total: 0, offset: 0, limit: 12, navigation: categoryNavigation(1) });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(renewable());
  const page = await runtime.page('index'); await settle();
  await page.search('未知分类');
  page.openArticle('category-0'); await settle();
  assert.equal(page.data.canRetry, true);
  assert.equal(page.libraryPage, null);
  press(page, 'ArrowDown');
  assert.equal(page.data.rows.length, 0);
  assert.equal(page.data.canRetry, true);
  assert.equal(runtime.navigation.length, 0);
  available = true;
  page.retry(); await settle();
  assert.equal(page.data.selectedId, 'voice-0');
  assert.equal(page.data.heading, '分类0');
  assert.equal(runtime.navigation.length, 0);
});

test('明确文章口令和引用标题以分类结尾时不误入分类回退', async () => {
  const runtime = createRuntime({ base: null });
  const { searchDemo } = await runtime.load('lib/search.js');
  const items = [{ ...voiceItem(0), title: '垃圾分类', category: { id: 'daily', name: '日常' } }];
  for (const query of ['查找文章垃圾分类', '文章垃圾分类', '查找《垃圾分类》']) {
    const result = searchDemo(items, query);
    assert.equal(result.kind, 'article');
    assert.equal(result.items[0].id, 'voice-0');
  }
  assert.equal(searchDemo(items, '查找文章不存在分类').total, 0);
});

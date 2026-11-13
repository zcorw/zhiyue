import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

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

function createRuntime({ base = origin, upgrade = false, request = () => assert.fail('没有预期网络请求') } = {}) {
  const storage = new Map();
  const timerQueue = new Map();
  const navigation = [];
  const players = [];
  const modules = new Map();
  let clock = 1_800_000_000_000;
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
  };
  const context = createContext({
    URL, AbortController, AbortSignal, fetch: (...args) => !upgrade && args[0].endsWith('/device/upgrade') ? Promise.resolve(json({}, 404)) : request(...args),
    Date: class extends Date { static now() { return clock; } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
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

  return { load, page, storage, navigation, players, advance, timerQueue };
}

function press(page, code) {
  let used = false;
  page.onKeyUp({ code, preventDefault() { used = true; } });
  return used;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

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
  assert.equal(runtime.storage.size, 1);
  const saved = JSON.parse([...runtime.storage.values()][0]);
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
  assert.equal(runtime.storage.size, 1);
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
  await settle();
  assert.equal(reader.data.hasBody, false);
  assert.match(reader.data.body, /授权已失效/);
  assert.equal(runtime.storage.size, 0);
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
  assert.equal(runtime.storage.size, 0);
  library.onShow();
  assert.equal(library.data.rows.length, 0);
  assert.equal(library.data.bound, false);
});

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
      return json({ ...session, access_token: `access-${renewals}`, refresh_token: 'stable-refresh' });
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
  const runtime = createRuntime({ upgrade: true, request: async (href, options) => {
    assert.ok(href.endsWith('/device/upgrade'));
    assert.equal(options.headers.Authorization, 'Bearer legacy');
    return json({ ...session, binding_id: mismatch ? 'wrong-binding' : session.binding_id,
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

test('401 refreshes once and a revoked retry cannot loop', async () => {
  let renewals = 0;
  let reads = 0;
  const runtime = createRuntime({ request: async (href) => {
    if (href.endsWith('/device/refresh')) {
      renewals++;
      return json({ ...session, access_token: 'replacement', refresh_token: 'refresh' });
    }
    reads++;
    return json({ error: 'invalid_token' }, 401);
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding({ token: 'old', refreshToken: 'refresh', expiresAt: 1_800_086_400_000,
    bindingId: session.binding_id, account: session.account });
  await assert.rejects(zhisheng.listArticles(0), { code: 'auth_required' });
  assert.equal(renewals, 1);
  assert.equal(reads, 2);
  assert.equal(zhisheng.getBinding(), null);
});

test('failed credential persistence is retryable and a fresh client restores expired access', async () => {
  const runtime = createRuntime();
  const { createZhishengClient } = await runtime.load('lib/zhisheng.js');
  let stored = null;
  let failWrite = false;
  let clock = 1_800_000_000_000;
  let count = 0;
  const storage = {
    getItem: () => stored,
    setItem: (_key, value) => { if (failWrite) throw new Error('disk'); stored = value; },
    removeItem: () => { stored = null; },
  };
  const request = async (href) => {
    assert.ok(href.endsWith('/device/refresh'));
    count++;
    return json({ ...session, access_token: `replacement-${count}`, refresh_token: 'refresh' });
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
  claim.resolve(json({ ...session, refresh_token: 'refresh' }));
  await poll;
  assert.deepEqual(revoked, [`Bearer ${session.access_token}`]);
  assert.equal(runtime.storage.size, 0);
});

function pendingGrant() {
  return { ...session, refresh_token: 'pending-refresh', confirmation_required: true };
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
      assert.equal(client.getBinding().pendingConfirmation, true);
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'pending-refresh' });
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      await wait.promise;
      return new Response(null, { status: 204 });
    }
    reads++;
    assert.equal(client.getBinding().pendingConfirmation, undefined);
    return json({ items: [], offset: 0, limit: 12, total: 0 });
  } });
  client = (await runtime.load('lib/zhisheng.js')).zhisheng;
  const binding = await client.exchangeDeviceCode('code');
  assert.equal(binding.pendingConfirmation, true);
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
  const storage = {
    getItem: () => raw,
    setItem: (_key, value) => { if (failSave) throw new Error('disk'); raw = value; },
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
  assert.equal(JSON.parse(raw).pendingConfirmation, true);
  client = createZhishengClient(options);
  failSave = true;
  await assert.rejects(client.ensureBinding(), { code: 'storage' });
  assert.equal(JSON.parse(raw).pendingConfirmation, true);
  failSave = false;
  client = createZhishengClient(options);
  await client.ensureBinding();
  assert.equal(confirms, 3);
  assert.equal(client.getBinding().pendingConfirmation, undefined);
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
  const runtime = createRuntime({ upgrade: true, request: async (href) => {
    assert.ok(href.endsWith('/device/upgrade'));
    upgrades++;
    if (upgrades === 1) throw new Error('lost upgrade response');
    return json({ ...session, refresh_token: 'recovered', confirmation_required: false });
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
  assert.equal(JSON.parse([...runtime.storage.values()][0]).pendingConfirmation, true);
  assert.equal(pair.data.action, '重试确认');
  await runtime.advance(5000);
  assert.equal(runtime.navigation.at(-1), 'back');
  assert.equal(JSON.parse([...runtime.storage.values()][0]).pendingConfirmation, undefined);
});

test('leaving pairing during confirm revokes and never reports success afterward', async () => {
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
  assert.equal(revoked, 1);
  assert.equal(runtime.storage.size, 0);
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
  assert.equal(zhisheng.getBinding().pendingConfirmation, true);
  revoke.resolve(new Response(null, { status: 204 }));
  await cancelling;
  assert.equal(zhisheng.getBinding(), null);
});

test('server rejection after the fixed legacy upgrade recovery window clears the local legacy grant', async () => {
  let upgrades = 0;
  const runtime = createRuntime({ upgrade: true, request: async (href) => {
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
    return json({ ...session, access_token: 'new-access', refresh_token: 'pending-refresh', confirmation_required: false });
  } });
  const { zhisheng } = await runtime.load('lib/zhisheng.js');
  zhisheng.saveBinding(await zhisheng.exchangeDeviceCode('code'));
  // The first confirmation succeeded remotely but its response was lost before this restart.
  await runtime.advance(2 * 86400000);
  await zhisheng.ensureBinding();
  assert.deepEqual(calls, ['confirm', 'refresh']);
  assert.equal(zhisheng.getBinding().pendingConfirmation, undefined);
  assert.equal(zhisheng.getBinding().token, 'new-access');
});

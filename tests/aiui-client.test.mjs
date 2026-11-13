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

function createRuntime({ base = origin, request = () => assert.fail('没有预期网络请求'),
  modern = false, storage = new Map(), startTime = 1_800_000_000_000, abortMode = 'standard' } = {}) {
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
  };
  const storageApi = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const context = createContext({
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
    assert.equal(runtime.storage.size, 0);
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
  assert.equal(runtime.storage.size, 0);
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
      const saved = JSON.parse([...runtime.storage.values()][0]);
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
      const saved = JSON.parse([...runtime.storage.values()][0]);
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
  assert.equal(JSON.parse([...runtime.storage.values()][0]).confirmationRequired, false);
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
      const saved = JSON.parse([...runtime.storage.values()][0]);
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

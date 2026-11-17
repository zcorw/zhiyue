import wx from 'wx';

const removed = '__zhiyue_removed_v1__';

// 优先使用宿主原生同步存储。localStorage 仅用于旧数据迁移和无原生能力的预览。
export function createPersistentStorage({ native = wx, legacy = globalThis.localStorage,
  files = globalThis.navigator?.storage } = {}) {
  const hasNative = typeof native?.getStorageSync === 'function'
    && typeof native?.setStorageSync === 'function';
  const readNative = (key) => {
    const value = native.getStorageSync(key);
    return value === undefined || value === null || value === '' ? null : value;
  };
  const writeNative = (key, value) => {
    native.setStorageSync(key, value);
    if (readNative(key) !== value) throw new Error('Native storage did not persist the value');
  };
  const keyValue = {
    getItem(key) {
      if (!hasNative) {
        const value = legacy.getItem(key);
        return value === removed ? null : value;
      }
      const value = readNative(key);
      if (value === removed) return null;
      if (value !== null) return value;
      const previous = legacy?.getItem(key) ?? null;
      if (previous === null) return null;
      writeNative(key, previous);
      return previous === removed ? null : previous;
    },
    setItem(key, value) {
      if (!hasNative) { legacy.setItem(key, value); return; }
      writeNative(key, value);
      // wx 与 localStorage 可能共用底层；不能通过另一接口删除刚写入的值。
    },
    removeItem(key) {
      if (!hasNative) { legacy.removeItem(key); return; }
      // 保留删除标记，防止注销后从旧 localStorage 副本重新恢复授权。
      writeNative(key, removed);
      // 同步删除标记而非删键，兼容共用底层及各自独立的两种宿主实现。
      try { legacy?.setItem(key, removed); } catch { /* 原生删除标记已可靠保存 */ }
    },
  };
  // Studio 的键值存储可能只在当前运行内有效；有 OPFS 时以智能体私有文件为准。
  if (typeof files?.getDirectory !== 'function') return { ...keyValue, isReady: () => true };

  const filename = 'zhiyue-credentials-v1.json';
  let values;
  let root;
  let loading;
  let writes = Promise.resolve();
  let writeFailed = false;
  const checkReady = () => {
    if (!values) throw new Error('Persistent storage is not initialized');
  };
  const readText = async (handle) => {
    const file = await handle.getFile();
    if (file.size > 128 * 1024) throw new Error('Credential file exceeds size limit');
    return new TextDecoder().decode(await file.arrayBuffer());
  };
  const missing = (error) => error?.name === 'NotFoundError' || /^NotFoundError\b/.test(String(error));
  function queueWrite() {
    const snapshot = JSON.stringify({ version: 1, values: Object.fromEntries(values) });
    writeFailed = false;
    writes = writes.catch(() => {}).then(async () => {
      const handle = await root.getFileHandle(filename, { create: true });
      const writer = await handle.createWritable();
      // 某些宿主不会自动截断；短凭据覆盖长凭据时也不能留下尾部内容。
      await writer.truncate(0);
      await writer.seek(0);
      await writer.write(snapshot);
      await writer.close();
      if (await readText(handle) !== snapshot) throw new Error('Credential file did not persist the value');
    });
    // 同步调用者可以先更新页面；异步门禁必须通过 flush 才能确认或发出授权请求。
    writes.catch(() => { writeFailed = true; });
  }
  return {
    isReady: () => Boolean(values),
    ready() {
      if (values) return Promise.resolve();
      if (loading) return loading;
      loading = (async () => {
        root = await files.getDirectory();
        let handle;
        try { handle = await root.getFileHandle(filename, { create: false }); }
        catch (error) { if (!missing(error)) throw error; }
        if (!handle) { values = new Map(); return; }
        const text = await readText(handle);
        // 首次写入在 close 前中断时可能仅创建了空文件。
        if (text === '') { values = new Map(); return; }
        const document = JSON.parse(text);
        if (document?.version !== 1 || !document.values || typeof document.values !== 'object'
            || Array.isArray(document.values) || !Object.entries(document.values).every(([key, value]) =>
              /^zhiyue\.(binding|device)\.v1:https:\/\//.test(key) && typeof value === 'string')) {
          throw new Error('Invalid credential file');
        }
        values = new Map(Object.entries(document.values));
      })().finally(() => { loading = null; });
      return loading;
    },
    async flush() {
      checkReady();
      if (writeFailed) queueWrite();
      await writes;
    },
    getItem(key) {
      checkReady();
      if (!values.has(key)) {
        const previous = keyValue.getItem(key);
        if (previous !== null) { values.set(key, previous); queueWrite(); }
      }
      const value = values.get(key);
      return value === undefined || value === removed ? null : value;
    },
    setItem(key, value) {
      checkReady();
      values.set(key, value);
      queueWrite();
    },
    removeItem(key) {
      checkReady();
      values.set(key, removed);
      queueWrite();
      try { keyValue.removeItem(key); } catch { /* 文件中的删除标记为准 */ }
    },
  };
}

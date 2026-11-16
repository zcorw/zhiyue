import wx from 'wx';

const removed = '__zhiyue_removed_v1__';

// 优先使用宿主原生同步存储。localStorage 仅用于旧数据迁移和无原生能力的预览。
export function createPersistentStorage({ native = wx, legacy = globalThis.localStorage } = {}) {
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
  return {
    getItem(key) {
      if (!hasNative) return legacy.getItem(key);
      const value = readNative(key);
      if (value === removed) return null;
      if (value !== null) return value;
      const previous = legacy?.getItem(key) ?? null;
      if (previous === null) return null;
      writeNative(key, previous);
      return previous;
    },
    setItem(key, value) {
      if (!hasNative) { legacy.setItem(key, value); return; }
      writeNative(key, value);
      // 清掉旧副本，防止旧进程中的访问凭据覆盖原生持久化的刷新凭据。
      try { legacy?.removeItem(key); } catch { /* 原生副本已可靠保存 */ }
    },
    removeItem(key) {
      if (!hasNative) { legacy.removeItem(key); return; }
      // 保留删除标记，防止注销后从旧 localStorage 副本重新恢复授权。
      writeNative(key, removed);
      try { legacy?.removeItem(key); } catch { /* 删除标记阻止旧授权复活 */ }
    },
  };
}

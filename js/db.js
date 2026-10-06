// IndexedDB 封装：数据库 eight-phrases / 仓库 slots，主键 id = 1..8。

const DB_NAME = 'eight-phrases';
const DB_VERSION = 1;
const STORE = 'slots';

export const SLOT_COUNT = 8;

export function emptySlot(id) {
  return {
    id,
    text: '',
    audio: null, // WAV 字节，存 ArrayBuffer 而不是 Blob（规避旧版 Safari 存 Blob 的问题）
    durationMs: 0,
    peaks: [],
    plays: 0,
    recordedAt: null,
    updatedAt: 0,
  };
}

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // 其他标签页升级数据库时让出连接
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
      req.onblocked = () => reject(new Error('数据库被其他页面占用'));
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

/** 读出全部 8 条，缺失的用空记录补齐，按 id 排好。 */
export async function getAll() {
  const rows = (await run('readonly', (store) => store.getAll())) || [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slots = [];
  for (let id = 1; id <= SLOT_COUNT; id++) slots.push({ ...emptySlot(id), ...byId.get(id) });
  return slots;
}

export function put(slot) {
  return run('readwrite', (store) => {
    store.put({ ...slot, updatedAt: Date.now() });
  });
}

export function clear() {
  return run('readwrite', (store) => {
    store.clear();
  });
}

/** 写入失败是否因为存储空间不足。 */
export function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
}

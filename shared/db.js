/*
 * 蓄積したPDFを保存するIndexedDBラッパー。
 * background.js (importScripts) と popup/manager (<script>) の両方から
 * グローバルの `DB` として利用する。
 *
 * 1レコード = 1回のキャプチャ(印刷1回分の複数ページPDF)。
 * ページ単位で分割して個別保存すると、pdf-libがページごとにフォント/画像
 * などの共有リソースを複製してしまい、ページ数に比例してファイルサイズが
 * 爆発的に増える(実測: 33ページで7.6MB→28MB、584ページで500MB超)。
 * これを避けるため、1回のキャプチャはPDFのまま1レコードとして保持し、
 * 「どのページを残すか」を keepPages (0始まりのページ番号配列) で管理する。
 */
(function () {
  const DB_NAME = "pdf-stacker-db";
  const DB_VERSION = 2;
  const STORE_NAME = "captures";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // v1の1ページ1レコード形式は非互換のため破棄する
        if (db.objectStoreNames.contains("pages")) {
          db.deleteObjectStore("pages");
        }
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // キャプチャを末尾に追加する(autoIncrementのidが挿入順=表示順になる)
  async function addCapture(capture) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).add(capture);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 挿入順(=キー昇順)で全キャプチャを返す
  async function getAllCaptures() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 既存レコードにフィールドをマージして保存する(keepPagesの更新などに使う)
  async function updateCapture(id, patch) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) {
          resolve();
          return;
        }
        Object.assign(record, patch);
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function deleteCapture(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 現在残っている(削除されていない)ページの総数
  async function countKeptPages() {
    const all = await getAllCaptures();
    return all.reduce((sum, c) => sum + c.keepPages.length, 0);
  }

  self.DB = {
    addCapture,
    getAllCaptures,
    updateCapture,
    deleteCapture,
    clearAll,
    countKeptPages,
  };
})();

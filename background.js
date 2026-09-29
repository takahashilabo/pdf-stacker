importScripts("lib/pdf-lib.min.js", "shared/db.js");

const UNCAPTURABLE_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:"];

// タブごとにdebuggerをアタッチしたままにして使い回す(章を移動するたびに
// アタッチし直すと、そのハンドシェイクの往復がボトルネックになるため)。
// 1つのタブには同時に1つしかdebuggerをアタッチできないので、この状態管理と
// 下のキュー(captureQueues)を組み合わせて連続キャプチャの衝突を防ぐ。
const attachedTabs = new Set();
// タブごとの直列キュー。同じタブへの連続キャプチャ(例: 本を1章ずつ素早く
// 「追加→次の章へ移動」を繰り返す)が同時に走ってdebuggerの取り合いに
// ならないよう、1つずつ順番に処理する。
const captureQueues = new Map();

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  captureQueues.delete(tabId);
  if (attachedTabs.has(tabId)) {
    attachedTabs.delete(tabId);
    chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  }
});

// DevToolsを手動で開いた場合など、外部要因でdebuggerが外れたら状態を追従させる
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-page") {
    handleCapture().then(flashBadgeResult);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "CAPTURE_CURRENT_TAB") {
    handleCapture().then(sendResponse);
    return true; // 非同期でsendResponseを呼ぶ
  }
  if (msg && msg.type === "REFRESH_BADGE") {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

function enqueueForTab(tabId, task) {
  const prev = captureQueues.get(tabId) || Promise.resolve();
  const settled = prev.then(task, task);
  // チェーン自体は失敗しても途切れないようにしておく(次のキャプチャが待てるように)
  captureQueues.set(tabId, settled.catch(() => {}));
  return settled;
}

async function handleCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: "アクティブなタブが見つかりませんでした" };
  }
  const scheme = (tab.url || "").split(":")[0] + ":";
  if (UNCAPTURABLE_SCHEMES.includes(scheme)) {
    return { ok: false, error: "このページはキャプチャできません(ブラウザの内部ページです)" };
  }
  return enqueueForTab(tab.id, () => captureOneTab(tab));
}

async function captureOneTab(tab) {
  try {
    const urlBeforeCapture = tab.url;
    const pdfBytes = await captureTabAsPdf(tab.id);

    // キャプチャ中にページが遷移していないか一応確認する(タイミング次第では
    // 取得中に別ページへ移動してしまうことがあるため、その場合はタイトルに
    // 注意書きを付けて後で見分けられるようにする)
    let titleSuffix = "";
    try {
      const freshTab = await chrome.tabs.get(tab.id);
      if (freshTab.url && urlBeforeCapture && freshTab.url !== urlBeforeCapture) {
        titleSuffix = " ⚠取得中にページが変わった可能性";
      }
    } catch (_) {
      // タブが閉じられていた等は無視(PDF自体は取得済み)
    }

    const { PDFDocument } = PDFLib;
    const pageCount = (await PDFDocument.load(pdfBytes)).getPageCount();

    // 印刷1回分をまるごと1レコードとして保存する。ページ単位に分割すると
    // pdf-libがページごとにフォント/画像を複製し、ページ数に比例して
    // ファイルサイズが爆発的に増えるため(実測: 584ページで500MB超)、
    // 分割はせずkeepPagesで「残すページ番号」だけを管理する。
    await DB.addCapture({
      pdfBytes,
      pageCount,
      keepPages: Array.from({ length: pageCount }, (_, i) => i),
      sourceTitle: (tab.title || "") + titleSuffix,
      sourceUrl: tab.url || "",
      capturedAt: Date.now(),
    });
    const total = await refreshBadge();
    return { ok: true, addedCount: pageCount, total };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await debuggerAttach({ tabId });
  await debuggerSendCommand({ tabId }, "Page.enable", {});
  attachedTabs.add(tabId);
}

async function getCaptureScale() {
  const { captureScalePercent } = await chrome.storage.local.get("captureScalePercent");
  const percent = Number(captureScalePercent) || 100;
  // CDP Page.printToPDFのscaleは0.1〜2の範囲のみ有効
  return Math.min(2, Math.max(0.1, percent / 100));
}

async function captureTabAsPdf(tabId) {
  await ensureAttached(tabId);
  const scale = await getCaptureScale();
  const result = await debuggerSendCommand({ tabId }, "Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    scale,
  });
  return base64ToUint8Array(result.data);
}

function debuggerAttach(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function debuggerSendCommand(debuggee, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function refreshBadge() {
  const total = await DB.countKeptPages();
  await chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#3B5BDB" });
  return total;
}

// ショートカットキー実行時はポップアップが無いのでバッジで一瞬結果を知らせる
async function flashBadgeResult(res) {
  if (res.ok) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2b8a3e" });
    await chrome.action.setBadgeText({ text: "OK" });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#c92a2a" });
    await chrome.action.setBadgeText({ text: "!" });
    console.error("PDF Stacker capture failed:", res.error);
  }
  setTimeout(refreshBadge, 1200);
}

importScripts("lib/pdf-lib.min.js", "shared/db.js");

const UNCAPTURABLE_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:"];

chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
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

async function handleCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("アクティブなタブが見つかりませんでした");
    }
    const scheme = (tab.url || "").split(":")[0] + ":";
    if (UNCAPTURABLE_SCHEMES.includes(scheme)) {
      throw new Error("このページはキャプチャできません(ブラウザの内部ページです)");
    }

    const pdfBytes = await captureTabAsPdf(tab.id);
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
      sourceTitle: tab.title || "",
      sourceUrl: tab.url || "",
      capturedAt: Date.now(),
    });
    const total = await refreshBadge();
    return { ok: true, addedCount: pageCount, total };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function captureTabAsPdf(tabId) {
  const debuggee = { tabId };
  await debuggerAttach(debuggee);
  try {
    await debuggerSendCommand(debuggee, "Page.enable", {});
    const result = await debuggerSendCommand(debuggee, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
    });
    return base64ToUint8Array(result.data);
  } finally {
    await debuggerDetach(debuggee);
  }
}

function debuggerAttach(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function debuggerDetach(debuggee) {
  return new Promise((resolve) => {
    chrome.debugger.detach(debuggee, () => resolve());
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

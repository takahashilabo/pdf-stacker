const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");
const manageBtn = document.getElementById("manageBtn");
const scaleInput = document.getElementById("scaleInput");

const DEFAULT_SCALE_PERCENT = 100;

async function loadScale() {
  const { captureScalePercent } = await chrome.storage.local.get("captureScalePercent");
  scaleInput.value = captureScalePercent || DEFAULT_SCALE_PERCENT;
}

scaleInput.addEventListener("change", () => {
  let percent = Math.round(Number(scaleInput.value));
  if (!Number.isFinite(percent)) percent = DEFAULT_SCALE_PERCENT;
  percent = Math.min(200, Math.max(10, percent));
  scaleInput.value = percent;
  chrome.storage.local.set({ captureScalePercent: percent });
});

async function refreshCount() {
  try {
    const total = await DB.countKeptPages();
    countEl.textContent = total > 0 ? `現在 ${total} ページ蓄積中` : "まだページがありません";
  } catch (err) {
    countEl.textContent = "";
  }
}

captureBtn.addEventListener("click", () => {
  captureBtn.disabled = true;
  statusEl.className = "status";
  statusEl.textContent = "キャプチャ中...(一瞬デバッグ用の通知バーが表示されます)";

  chrome.runtime.sendMessage({ type: "CAPTURE_CURRENT_TAB" }, (res) => {
    captureBtn.disabled = false;
    if (chrome.runtime.lastError) {
      statusEl.className = "status error";
      statusEl.textContent = "エラー: " + chrome.runtime.lastError.message;
      return;
    }
    if (res && res.ok) {
      statusEl.className = "status success";
      statusEl.textContent = `${res.addedCount}ページ追加しました(合計${res.total}ページ)`;
      refreshCount();
    } else {
      statusEl.className = "status error";
      statusEl.textContent = "エラー: " + (res && res.error ? res.error : "不明なエラー");
    }
  });
});

manageBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manager/manager.html") });
});

refreshCount();
loadScale();

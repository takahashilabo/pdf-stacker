pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("emptyMsg");
const pageCountEl = document.getElementById("pageCount");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");

async function renderThumbnail(pdfBytes, canvas) {
  // pdf.jsはArrayBufferをdetach(transfer)するので複製を渡す
  const data = new Uint8Array(pdfBytes).slice();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const targetWidth = 200;
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
}

async function load() {
  const pages = await DB.getAllPages(); // 挿入順=キー昇順=表示順(末尾に連結された順)
  grid.innerHTML = "";
  pageCountEl.textContent = pages.length > 0 ? `${pages.length} ページ` : "";
  emptyMsg.hidden = pages.length > 0;
  downloadBtn.disabled = pages.length === 0;
  clearBtn.disabled = pages.length === 0;

  pages.forEach((p, idx) => {
    const card = document.createElement("div");
    card.className = "card";

    const canvas = document.createElement("canvas");
    card.appendChild(canvas);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.title = `${p.sourceTitle || ""}\n${p.sourceUrl || ""}`;
    meta.textContent = `#${idx + 1}  ${p.sourceTitle || "(無題)"}`;
    card.appendChild(meta);

    const delBtn = document.createElement("button");
    delBtn.className = "del";
    delBtn.textContent = "このページを削除";
    delBtn.addEventListener("click", async () => {
      await DB.deletePage(p.id);
      await load();
      chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
    });
    card.appendChild(delBtn);

    grid.appendChild(card);

    renderThumbnail(p.pdfBytes, canvas).catch((err) => {
      meta.textContent += " (プレビュー生成失敗)";
      console.error("thumbnail render failed", err);
    });
  });
}

refreshBtn.addEventListener("click", load);

clearBtn.addEventListener("click", async () => {
  if (!confirm("蓄積したすべてのページを削除します。よろしいですか?")) return;
  await DB.clearAll();
  await load();
  chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
});

downloadBtn.addEventListener("click", async () => {
  downloadBtn.disabled = true;
  const originalLabel = downloadBtn.textContent;
  downloadBtn.textContent = "結合中...";
  try {
    const pages = await DB.getAllPages();
    if (pages.length === 0) return;

    const { PDFDocument } = PDFLib;
    const merged = await PDFDocument.create();
    for (const p of pages) {
      const src = await PDFDocument.load(p.pdfBytes);
      const [copiedPage] = await merged.copyPages(src, [0]);
      merged.addPage(copiedPage);
    }
    const mergedBytes = await merged.save();
    const blob = new Blob([mergedBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = buildFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.error(err);
    alert("PDFの結合に失敗しました: " + err.message);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalLabel;
  }
});

function buildFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `stacked-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.pdf`;
}

load();

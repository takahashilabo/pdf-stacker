pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("emptyMsg");
const pageCountEl = document.getElementById("pageCount");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");

async function renderThumbnailFromDoc(pdfjsDoc, pageIndex, canvas) {
  const page = await pdfjsDoc.getPage(pageIndex + 1); // pdf.jsは1始まり
  const baseViewport = page.getViewport({ scale: 1 });
  const targetWidth = 200;
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
}

function buildCard(cap, pageIndex, displayIdx, pdfjsDoc) {
  const card = document.createElement("div");
  card.className = "card";

  const canvas = document.createElement("canvas");
  card.appendChild(canvas);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.title = `${cap.sourceTitle || ""}\n${cap.sourceUrl || ""}`;
  meta.textContent = `#${displayIdx}  ${cap.sourceTitle || "(無題)"}`;
  card.appendChild(meta);

  const delBtn = document.createElement("button");
  delBtn.className = "del";
  delBtn.textContent = "このページを削除";
  delBtn.addEventListener("click", async () => {
    const newKeep = cap.keepPages.filter((p) => p !== pageIndex);
    if (newKeep.length === 0) {
      await DB.deleteCapture(cap.id);
    } else {
      await DB.updateCapture(cap.id, { keepPages: newKeep });
    }
    await load();
    chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
  });
  card.appendChild(delBtn);

  if (pdfjsDoc) {
    renderThumbnailFromDoc(pdfjsDoc, pageIndex, canvas).catch((err) => {
      meta.textContent += " (プレビュー生成失敗)";
      console.error("thumbnail render failed", err);
    });
  } else {
    meta.textContent += " (プレビュー生成失敗)";
  }

  return card;
}

async function load() {
  const captures = await DB.getAllCaptures(); // 挿入順=キャプチャした順=表示順
  grid.innerHTML = "";

  let totalPages = 0;
  for (const cap of captures) totalPages += cap.keepPages.length;
  pageCountEl.textContent = totalPages > 0 ? `${totalPages} ページ` : "";
  emptyMsg.hidden = totalPages > 0;
  downloadBtn.disabled = totalPages === 0;
  clearBtn.disabled = totalPages === 0;

  let displayIdx = 0;
  for (const cap of captures) {
    if (cap.keepPages.length === 0) continue;

    // 1キャプチャにつきpdf.jsのパースは1回だけ行い、そこから各ページを描画する
    // (ページごとに毎回パースし直すと584ページ級のデータで極端に重くなる)
    let pdfjsDoc = null;
    try {
      const data = new Uint8Array(cap.pdfBytes).slice();
      pdfjsDoc = await pdfjsLib.getDocument({ data }).promise;
    } catch (err) {
      console.error("failed to load capture for thumbnails", err);
    }

    for (const pageIndex of cap.keepPages) {
      displayIdx++;
      grid.appendChild(buildCard(cap, pageIndex, displayIdx, pdfjsDoc));
    }
  }
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
    const captures = (await DB.getAllCaptures()).filter((c) => c.keepPages.length > 0);
    if (captures.length === 0) return;

    const { PDFDocument } = PDFLib;
    const merged = await PDFDocument.create();
    for (const cap of captures) {
      const src = await PDFDocument.load(cap.pdfBytes);
      // 1キャプチャ分をまとめてcopyPagesすることで、フォント等の共有リソースが
      // キャプチャ内で1回だけコピーされる(ページ単位でcopyPagesすると
      // 呼ぶたびに複製されファイルサイズが爆発的に増える)。
      const copiedPages = await merged.copyPages(src, cap.keepPages);
      copiedPages.forEach((p) => merged.addPage(p));
    }
    const mergedBytes = await merged.save();
    const blob = new Blob([mergedBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    // 拡張機能ページからの <a download> はPDFのblobだとタブ内表示に化けて
    // PDFビューアのエラー(コード5など)になることがあるため、
    // chrome.downloads API で確実にファイルとして保存する。
    try {
      await chrome.downloads.download({
        url,
        filename: buildFilename(),
        saveAs: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  } catch (err) {
    console.error(err);
    alert("PDFの結合またはダウンロードに失敗しました: " + err.message);
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

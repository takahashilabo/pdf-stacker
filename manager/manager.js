pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

const grid = document.getElementById("grid");
const emptyMsg = document.getElementById("emptyMsg");
const pageCountEl = document.getElementById("pageCount");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const downloadBtn = document.getElementById("downloadBtn");
const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");

// 削除のたびにload()でグリッド全体(サムネイル再描画含む)をやり直すと、
// まとめて何ページも消したいときに毎回リロードが挟まって面倒なため、
// 削除操作はDB更新とカード側の見た目の更新(薄く表示+ボタン無効化)だけに
// とどめ、グリッドの再構築は「再読み込み」ボタンを押したときだけ行う。
let remainingTotal = 0;

// Finderのシフトクリック範囲選択と同じ操作感にするための状態。
// cardOrderは表示順に並んだ{cap, pageIndex, card}で、シフトクリック時に
// lastClickedIndexから現在のインデックスまでの範囲を選択状態にする。
let cardOrder = [];
let selectedIndices = new Set();
let lastClickedIndex = null;

function updateBulkDeleteBtn() {
  const n = selectedIndices.size;
  bulkDeleteBtn.textContent = n > 0 ? `選択した${n}ページを削除` : "選択したページを削除";
  bulkDeleteBtn.disabled = n === 0;
}

function setCardSelected(orderIndex, selected) {
  const entry = cardOrder[orderIndex];
  if (!entry || entry.card.classList.contains("deleted")) return;
  if (selected) {
    selectedIndices.add(orderIndex);
    entry.card.classList.add("selected");
  } else {
    selectedIndices.delete(orderIndex);
    entry.card.classList.remove("selected");
  }
}

function decrementRemainingTotal() {
  remainingTotal = Math.max(0, remainingTotal - 1);
  pageCountEl.textContent = remainingTotal > 0 ? `${remainingTotal} ページ` : "";
  downloadBtn.disabled = remainingTotal === 0;
  clearBtn.disabled = remainingTotal === 0;
}

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

function buildCard(cap, pageIndex, displayIdx, pdfjsDoc, orderIndex) {
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
    delBtn.disabled = true;
    const originalLabel = delBtn.textContent;
    delBtn.textContent = "削除中...";
    try {
      // capは同じキャプチャの他ページのカードとも共有しているオブジェクトなので、
      // ここで直接書き換えることで同一キャプチャ内の連続削除にも正しく追従する
      const newKeep = cap.keepPages.filter((p) => p !== pageIndex);
      cap.keepPages = newKeep;
      if (newKeep.length === 0) {
        await DB.deleteCapture(cap.id);
      } else {
        await DB.updateCapture(cap.id, { keepPages: newKeep });
      }
      setCardSelected(orderIndex, false);
      card.classList.add("deleted");
      delBtn.textContent = "削除済み";
      decrementRemainingTotal();
      updateBulkDeleteBtn();
      chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
    } catch (err) {
      delBtn.disabled = false;
      delBtn.textContent = originalLabel;
      alert("削除に失敗しました: " + err.message);
    }
  });
  card.appendChild(delBtn);

  // Finderのファイル選択と同じ操作感: クリックで単一トグル、シフト+クリックで
  // 前回クリックしたカードから今回までを範囲選択する。削除ボタン自体の
  // クリックは選択トグルに巻き込まない。
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (card.classList.contains("deleted")) return;

    if (e.shiftKey && lastClickedIndex !== null) {
      const [from, to] = [lastClickedIndex, orderIndex].sort((a, b) => a - b);
      for (let i = from; i <= to; i++) setCardSelected(i, true);
    } else {
      setCardSelected(orderIndex, !selectedIndices.has(orderIndex));
      lastClickedIndex = orderIndex;
    }
    updateBulkDeleteBtn();
  });

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
  cardOrder = [];
  selectedIndices = new Set();
  lastClickedIndex = null;
  updateBulkDeleteBtn();

  let totalPages = 0;
  for (const cap of captures) totalPages += cap.keepPages.length;
  remainingTotal = totalPages;
  pageCountEl.textContent = totalPages > 0 ? `${totalPages} ページ` : "";
  emptyMsg.hidden = totalPages > 0;
  downloadBtn.disabled = totalPages === 0;
  clearBtn.disabled = totalPages === 0;

  let displayIdx = 0;
  let orderIndex = 0;
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
      const card = buildCard(cap, pageIndex, displayIdx, pdfjsDoc, orderIndex);
      cardOrder.push({ cap, pageIndex, card });
      grid.appendChild(card);
      orderIndex++;
    }
  }
}

bulkDeleteBtn.addEventListener("click", async () => {
  const indices = Array.from(selectedIndices).sort((a, b) => a - b);
  if (indices.length === 0) return;
  bulkDeleteBtn.disabled = true;
  bulkDeleteBtn.textContent = "削除中...";
  try {
    // 同じキャプチャに属する選択ページはkeepPages更新を1回にまとめる
    // (ページごとに毎回updateCaptureを呼ぶと選択数が多いときにDB書き込みが増えるため)
    const byCap = new Map();
    for (const i of indices) {
      const entry = cardOrder[i];
      if (!entry || entry.card.classList.contains("deleted")) continue;
      if (!byCap.has(entry.cap)) byCap.set(entry.cap, []);
      byCap.get(entry.cap).push(entry);
    }

    for (const [cap, entries] of byCap) {
      const removeSet = new Set(entries.map((e) => e.pageIndex));
      const newKeep = cap.keepPages.filter((p) => !removeSet.has(p));
      cap.keepPages = newKeep;
      if (newKeep.length === 0) {
        await DB.deleteCapture(cap.id);
      } else {
        await DB.updateCapture(cap.id, { keepPages: newKeep });
      }
      for (const entry of entries) {
        entry.card.classList.add("deleted");
        entry.card.classList.remove("selected");
        const delBtn = entry.card.querySelector("button.del");
        if (delBtn) {
          delBtn.disabled = true;
          delBtn.textContent = "削除済み";
        }
        decrementRemainingTotal();
      }
    }

    selectedIndices.clear();
    updateBulkDeleteBtn();
    chrome.runtime.sendMessage({ type: "REFRESH_BADGE" });
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
    updateBulkDeleteBtn();
  }
});

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

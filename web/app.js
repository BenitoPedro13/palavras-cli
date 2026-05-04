import {
  WORDS_URL_PT,
  FREQUENCY_URL_PT,
  WORDS_URL_EN,
  FREQUENCY_URL_EN,
  parseFrequencyCorpus,
  extractCandidateSequences,
  chooseBestSequence,
  buildSearchPresentation,
  clampWordLengthBounds,
  DEFAULT_MIN_WORD_LENGTH,
  DEFAULT_MAX_WORD_LENGTH,
} from "./engine.js";

/** Tesseract.js via CDN (WASM no browser — funciona em Windows, Linux, macOS). */
const TESSERACT_ESM = "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/+esm";

/** Nome estável: o Chrome reutiliza a mesma janela se já existir. */
const SUGGESTIONS_WINDOW_NAME = "palavras_sugestoes_panel";

let words = [];
let freqMap = new Map();
let tesseractModule = null;
/** @type {"pt" | "en"} */
let currentLang = "pt";

/** Partilha de ecrã + OCR contínuo */
let screenActive = false;
let screenStream = null;
let screenWorker = null;
let lastBestSequenceLive = "";
/** Chave `min-max` para repetir OCR sem re-render quando só o filtro de comprimento mudou (o slider trata disso). */
let lastOcrBoundsKey = "";
/** @type {Window | null} */
let suggestionsWindow = null;
/** @type {{ x0: number, y0: number } | null} */
let overlayDrag = null;

const el = {
  statusDict: document.getElementById("status-dict"),
  langSelect: document.getElementById("lang-select"),
  btnLoad: document.getElementById("btn-load-dict"),
  btnOpenSuggestions: document.getElementById("btn-open-suggestions"),
  btnScreenStart: document.getElementById("btn-screen-start"),
  btnScreenStop: document.getElementById("btn-screen-stop"),
  screenPollMs: document.getElementById("screen-poll-ms"),
  screenMaxW: document.getElementById("screen-max-w"),
  cropLeft: document.getElementById("crop-left"),
  cropTop: document.getElementById("crop-top"),
  cropW: document.getElementById("crop-w"),
  cropH: document.getElementById("crop-h"),
  screenStatus: document.getElementById("screen-status"),
  screenPreviewWrap: document.getElementById("screen-preview-wrap"),
  screenVideoStack: document.getElementById("screen-video-stack"),
  screenPreview: document.getElementById("screen-preview"),
  screenOverlay: document.getElementById("screen-overlay"),
  previewMaxHeightRange: document.getElementById("preview-max-height-range"),
  previewMaxHeightOut: document.getElementById("preview-max-height-out"),
  screenSelectionBox: document.getElementById("screen-selection-box"),
  screenOcrProgress: document.getElementById("screen-ocr-progress"),
  btnCropFull: document.getElementById("btn-crop-full"),
  wordLenMin: document.getElementById("word-len-min"),
  wordLenMax: document.getElementById("word-len-max"),
  wordLenMinOut: document.getElementById("word-len-min-out"),
  wordLenMaxOut: document.getElementById("word-len-max-out"),
};

function setStatus(msg, isError = false) {
  el.statusDict.textContent = msg;
  el.statusDict.classList.toggle("error", isError);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readWordLengthBoundsFromUi() {
  if (!el.wordLenMin || !el.wordLenMax) {
    return clampWordLengthBounds(DEFAULT_MIN_WORD_LENGTH, DEFAULT_MAX_WORD_LENGTH);
  }
  return clampWordLengthBounds(Number(el.wordLenMin.value), Number(el.wordLenMax.value));
}

function wordLengthBoundsKey() {
  const { minLen, maxLen } = readWordLengthBoundsFromUi();
  return `${minLen}-${maxLen}`;
}

function syncWordLengthSliderOutputs() {
  if (!el.wordLenMin || !el.wordLenMax) {
    return;
  }
  const { minLen, maxLen } = readWordLengthBoundsFromUi();
  el.wordLenMin.value = String(minLen);
  el.wordLenMax.value = String(maxLen);
  if (el.wordLenMinOut) {
    el.wordLenMinOut.textContent = String(minLen);
  }
  if (el.wordLenMaxOut) {
    el.wordLenMaxOut.textContent = String(maxLen);
  }
}

/** Atualiza sugestões com a última sequência detetada (útil ao mudar o filtro de comprimento). */
function refreshLiveSearchIfPossible() {
  syncWordLengthSliderOutputs();
  if (!words.length || !lastBestSequenceLive) {
    return;
  }
  lastOcrBoundsKey = wordLengthBoundsKey();
  runSearch(lastBestSequenceLive, true);
}

function clampNum(n, min, max) {
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}

function readCropPercents() {
  const left = clampNum(Number(el.cropLeft.value), 0, 100);
  const top = clampNum(Number(el.cropTop.value), 0, 100);
  let width = clampNum(Number(el.cropW.value), 1, 100);
  let height = clampNum(Number(el.cropH.value), 1, 100);
  if (left + width > 100) {
    width = 100 - left;
  }
  if (top + height > 100) {
    height = 100 - top;
  }
  return { left, top, width, height };
}

/**
 * Amostra o frame atual do vídeo, aplica recorte opcional (%) e reduz para acelerar o OCR.
 * @returns {Promise<Blob | null>}
 */
async function captureVideoFrameToBlob(video, maxW, crop) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    return null;
  }

  const sx = Math.round((crop.left / 100) * vw);
  const sy = Math.round((crop.top / 100) * vh);
  const sw = Math.max(1, Math.round((crop.width / 100) * vw));
  const sh = Math.max(1, Math.round((crop.height / 100) * vh));
  const scale = Math.min(1, maxW / sw);
  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
}

/**
 * Área útil do frame dentro do elemento de vídeo (ignora letterbox de object-fit: contain).
 * Coordenadas em espaço de cliente do vídeo (0..clientWidth/Height).
 * @returns {{ offX: number, offY: number, cw: number, ch: number, iw: number, ih: number } | null}
 */
function getLetterboxContentRect(video) {
  const iw = video.videoWidth;
  const ih = video.videoHeight;
  const rect = video.getBoundingClientRect();
  const ew = rect.width;
  const eh = rect.height;
  if (!iw || !ih || !ew || !eh) {
    return null;
  }

  const ir = iw / ih;
  const er = ew / eh;
  let cw;
  let ch;
  let offX;
  let offY;
  if (ir > er) {
    cw = ew;
    ch = ew / ir;
    offX = 0;
    offY = (eh - ch) / 2;
  } else {
    ch = eh;
    cw = eh * ir;
    offX = (ew - cw) / 2;
    offY = 0;
  }

  return { offX, offY, cw, ch, iw, ih };
}

function intersectContentRects(a, b) {
  const ax2 = a.left + a.width;
  const ay2 = a.top + a.height;
  const bx2 = b.left + b.width;
  const by2 = b.top + b.height;
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < 6 || h < 6) {
    return null;
  }
  return { left: x1, top: y1, width: w, height: h };
}

function setCropInputsFromIntrinsicPercents(leftPct, topPct, widthPct, heightPct) {
  const round = (n) => Math.round(clampNum(n, 0, 100) * 10) / 10;
  let l = round(leftPct);
  let t = round(topPct);
  let w = Math.max(0.1, round(widthPct));
  let h = Math.max(0.1, round(heightPct));
  if (l + w > 100) {
    w = Math.round((100 - l) * 10) / 10;
  }
  if (t + h > 100) {
    h = Math.round((100 - t) * 10) / 10;
  }
  el.cropLeft.value = String(l);
  el.cropTop.value = String(t);
  el.cropW.value = String(Math.max(0.1, w));
  el.cropH.value = String(Math.max(0.1, h));
  syncCropBoxVisual();
}

/** Atualiza o retângulo tracejado a partir dos campos % (vídeo intrínseco). */
function syncCropBoxVisual() {
  if (el.screenPreviewWrap.classList.contains("hidden")) {
    el.screenSelectionBox.hidden = true;
    return;
  }

  const lb = getLetterboxContentRect(el.screenPreview);
  if (!lb) {
    el.screenSelectionBox.hidden = true;
    return;
  }

  const c = readCropPercents();
  const ix = (c.left / 100) * lb.iw;
  const iy = (c.top / 100) * lb.ih;
  const iiw = (c.width / 100) * lb.iw;
  const iih = (c.height / 100) * lb.ih;
  const scaleX = lb.cw / lb.iw;
  const scaleY = lb.ch / lb.ih;
  const left = lb.offX + ix * scaleX;
  const top = lb.offY + iy * scaleY;
  const width = iiw * scaleX;
  const height = iih * scaleY;

  el.screenSelectionBox.hidden = false;
  el.screenSelectionBox.style.left = `${Math.round(left)}px`;
  el.screenSelectionBox.style.top = `${Math.round(top)}px`;
  el.screenSelectionBox.style.width = `${Math.max(1, Math.round(width))}px`;
  el.screenSelectionBox.style.height = `${Math.max(1, Math.round(height))}px`;
}

function applyOverlayDragToCrop(x0, y0, x1, y1) {
  const lb = getLetterboxContentRect(el.screenPreview);
  if (!lb) {
    return;
  }

  const drag = {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };

  const content = { left: lb.offX, top: lb.offY, width: lb.cw, height: lb.ch };
  const ix = intersectContentRects(drag, content);
  if (!ix) {
    el.screenStatus.textContent = "Seleção demasiado pequena ou fora da área útil do vídeo.";
    return;
  }

  const relL = ((ix.left - lb.offX) / lb.cw) * lb.iw;
  const relT = ((ix.top - lb.offY) / lb.ch) * lb.ih;
  const relW = (ix.width / lb.cw) * lb.iw;
  const relH = (ix.height / lb.ch) * lb.ih;

  const leftPct = (relL / lb.iw) * 100;
  const topPct = (relT / lb.ih) * 100;
  const widthPct = (relW / lb.iw) * 100;
  const heightPct = (relH / lb.ih) * 100;

  setCropInputsFromIntrinsicPercents(leftPct, topPct, widthPct, heightPct);
  el.screenStatus.textContent = `Zona OCR: ${el.cropLeft.value}% ${el.cropTop.value}% — ${el.cropW.value}%×${el.cropH.value}%`;
}

function updateOverlayDragBox(x0, y0, x1, y1) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  el.screenSelectionBox.hidden = false;
  el.screenSelectionBox.style.left = `${Math.round(left)}px`;
  el.screenSelectionBox.style.top = `${Math.round(top)}px`;
  el.screenSelectionBox.style.width = `${Math.max(1, Math.round(width))}px`;
  el.screenSelectionBox.style.height = `${Math.max(1, Math.round(height))}px`;
}

/** Coordenadas relativas ao contentor do vídeo (robusto com scroll e tamanhos grandes). */
function pointerToStackCoords(e) {
  const base = el.screenVideoStack ?? el.screenOverlay;
  if (!base) {
    return { x: 0, y: 0 };
  }
  const r = base.getBoundingClientRect();
  const x = clampNum(e.clientX - r.left, 0, r.width);
  const y = clampNum(e.clientY - r.top, 0, r.height);
  return { x, y };
}

function wireCropOverlay() {
  el.screenOverlay.addEventListener("pointerdown", (e) => {
    if (!screenStream || e.button !== 0) {
      return;
    }
    e.preventDefault();
    const { x, y } = pointerToStackCoords(e);
    overlayDrag = { x0: x, y0: y };
    try {
      el.screenOverlay.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    updateOverlayDragBox(overlayDrag.x0, overlayDrag.y0, x, y);
  });

  el.screenOverlay.addEventListener("pointermove", (e) => {
    if (!overlayDrag) {
      return;
    }
    const { x, y } = pointerToStackCoords(e);
    updateOverlayDragBox(overlayDrag.x0, overlayDrag.y0, x, y);
  });

  const endDrag = (e) => {
    if (!overlayDrag) {
      return;
    }
    const { x0, y0 } = overlayDrag;
    overlayDrag = null;
    try {
      el.screenOverlay.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const { x, y } = pointerToStackCoords(e);
    applyOverlayDragToCrop(x0, y0, x, y);
  };

  el.screenOverlay.addEventListener("pointerup", endDrag);
  el.screenOverlay.addEventListener("pointercancel", endDrag);
}

function applyPreviewMaxHeightPx(px) {
  const p = Math.round(clampNum(Number(px), 240, 900));
  el.screenPreviewWrap.style.setProperty("--preview-max-height", `${p}px`);
  el.previewMaxHeightRange.value = String(p);
  el.previewMaxHeightOut.textContent = String(p);
}

const cropLayoutObserver = new ResizeObserver(() => {
  syncCropBoxVisual();
});
cropLayoutObserver.observe(el.screenPreviewWrap);

el.previewMaxHeightRange.addEventListener("input", () => {
  applyPreviewMaxHeightPx(el.previewMaxHeightRange.value);
  syncCropBoxVisual();
});

for (const id of [el.cropLeft, el.cropTop, el.cropW, el.cropH]) {
  id.addEventListener("input", () => syncCropBoxVisual());
}

el.btnCropFull.addEventListener("click", () => {
  el.cropLeft.value = "0";
  el.cropTop.value = "0";
  el.cropW.value = "100";
  el.cropH.value = "100";
  syncCropBoxVisual();
  el.screenStatus.textContent = "Zona OCR: ecrã inteiro (vídeo útil).";
});

el.screenPreview.addEventListener("loadedmetadata", () => {
  syncCropBoxVisual();
});

wireCropOverlay();

applyPreviewMaxHeightPx(el.previewMaxHeightRange.value);

function getSuggestionsWindow() {
  if (suggestionsWindow && !suggestionsWindow.closed) {
    return suggestionsWindow;
  }
  return null;
}

/**
 * Abre ou foca a janela de sugestões. Tem de correr dentro de um gesto do utilizador (evita bloqueio de pop-up).
 * @returns {Window | null}
 */
function openSuggestionsWindowFromUserGesture() {
  const w = window.open(
    "",
    SUGGESTIONS_WINDOW_NAME,
    "popup=no,width=520,height=720,left=64,top=48"
  );
  if (!w) {
    setStatus("O browser bloqueou a janela — permite pop-ups para este site.", true);
    return null;
  }

  suggestionsWindow = w;

  if (!w.document.getElementById("suggestions-root")) {
    w.document.open();
    w.document.write(getSuggestionsShellHtml());
    w.document.close();
  }

  try {
    w.focus();
  } catch {
    /* ignore */
  }

  return w;
}

function getSuggestionsShellHtml() {
  const scr = "</scr" + "ipt>";
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sugestões — palavras</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0f1216;
      --fg: #e8eaed;
      --muted: #9aa0a6;
      --accent: #3b82f6;
      --card: #1a1f26;
      --border: #2d3540;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f6f8;
        --fg: #111827;
        --muted: #4b5563;
        --card: #fff;
        --border: #e5e7eb;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0.85rem 1rem;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.45;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      padding-bottom: 0.65rem;
      border-bottom: 1px solid var(--border);
    }
    .toolbar h1 { font-size: 1.05rem; font-weight: 650; margin: 0; }
    button {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 0.4rem 0.75rem;
      border-radius: 8px;
      font-size: 0.85rem;
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.85rem 1rem;
      margin-bottom: 0.65rem;
    }
    .card h2 { font-size: 1rem; margin: 0 0 0.35rem; }
    .card h3 { font-size: 0.9rem; margin: 0 0 0.35rem; }
    .muted { color: var(--muted); font-size: 0.88rem; }
    .hero { font-size: 1.08rem; margin: 0.35rem 0 0; }
    ul { margin: 0.25rem 0 0; padding-left: 1.15rem; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Sugestões</h1>
    <button type="button" id="w-copy-pick" disabled>Copiar melhor candidato</button>
  </div>
  <div id="suggestions-root"><p class="muted">À espera da primeira deteção…</p></div>
  <script>
    (function () {
      var btn = document.getElementById("w-copy-pick");
      btn.addEventListener("click", function () {
        var t = window.__palavrasPick || "";
        if (!t) return;
        navigator.clipboard.writeText(t).catch(function () {});
      });
    })();
  ${scr}
</body>
</html>`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSuggestionsHtml(pres) {
  const loc = pres.locale ?? "pt-BR";
  const isEn = pres.lang === "en";
  const freqLine = pres.pickFreqLine ?? (isEn ? "not in corpus" : "sem ocorrência no corpus");
  const lettersWord = isEn ? "letters" : "letras";
  const seqTitle = isEn ? "Sequence" : "Sequência";
  const dictCount = `${pres.matchCount.toLocaleString(loc)} ${isEn ? "word(s) in dictionary" : "palavra(s) no dicionário"}`;
  const bestTitle = isEn ? "Best candidate" : "Melhor candidato";
  const otherTitle = isEn ? "Other options (length, then corpus)" : "Outras opções (comprimento, depois corpus)";
  const topTitle = isEn
    ? `Top 5 by tile score (${escapeHtml(pres.scrabbleLabel ?? "Scrabble")})`
    : `Top 5 maior pontuação (${escapeHtml(pres.scrabbleLabel ?? "Scrabble BR")})`;

  const lf = pres.lengthFilter;
  const lengthFilterLine =
    lf &&
    (isEn
      ? `Word length allowed: ${lf.minLen}–${lf.maxLen} letters`
      : `Comprimento permitido: ${lf.minLen}–${lf.maxLen} letras`);

  let html = `<section class="card">
    <h2>${seqTitle}: ${escapeHtml(pres.sequenceUpper)}</h2>
    <p class="muted">${dictCount}</p>
    ${lengthFilterLine ? `<p class="muted">${escapeHtml(lengthFilterLine)}</p>` : ""}
    <p><strong>${bestTitle}</strong> <span class="muted">(${escapeHtml(pres.criterionNote)})</span></p>
    <p class="hero">→ <strong>${escapeHtml(pres.pickShown)}</strong> (${escapeHtml(pres.pickHighlight)}) — ${pres.pickLen} ${lettersWord}; ${escapeHtml(freqLine)}</p>
  </section>`;

  if (pres.restForPlay.length) {
    html += `<section class="card"><h3>${otherTitle}</h3><ul>`;
    for (const row of pres.restForPlay) {
      html += `<li><strong>${escapeHtml(row.shown)}</strong> (${escapeHtml(row.highlight)}) — ${row.len} ${lettersWord}; ${escapeHtml(row.freqLabel)}</li>`;
    }
    html += `</ul></section>`;
  }

  html += `<section class="card"><h3>${topTitle}</h3><ul>`;
  for (const row of pres.highestPoints) {
    html += `<li><strong>${escapeHtml(row.shown)}</strong> (${escapeHtml(row.highlight)}) — ${row.points} ${isEn ? "points" : "pontos"}</li>`;
  }
  html += `</ul></section>`;

  return html;
}

function renderPresentation(pres) {
  const rw = getSuggestionsWindow();
  if (!rw) {
    setStatus("Abre a janela de sugestões (botão no topo) para ver palavras.", true);
    return;
  }

  const pick = pres?.pickShown ?? "";
  rw.__palavrasPick = pick;
  const copyBtn = rw.document.getElementById("w-copy-pick");
  if (copyBtn) {
    copyBtn.disabled = !pick;
  }

  const root = rw.document.getElementById("suggestions-root");
  if (!root) {
    return;
  }

  if (!pres) {
    root.innerHTML =
      '<p class="muted">Nenhuma palavra encontrada para esta sequência.</p>';
    return;
  }

  root.innerHTML = buildSuggestionsHtml(pres);
}

function langUi() {
  if (currentLang === "en") {
    return {
      lang: "en",
      locale: "en-US",
      freqCorpusShort: "FrequencyWords / OpenSubtitles EN",
      scrabbleLabel: "Scrabble (EN / international tiles)",
      ocrLanguages: "eng",
    };
  }
  return {
    lang: "pt",
    locale: "pt-BR",
    freqCorpusShort: "FrequencyWords / legendas PT",
    scrabbleLabel: "Scrabble BR",
    ocrLanguages: "por+eng",
  };
}

function runSearch(sequence, humanTier) {
  const u = langUi();
  const { minLen, maxLen } = readWordLengthBoundsFromUi();
  const pres = buildSearchPresentation(words, freqMap, sequence, {
    humanTierWordPick: humanTier,
    locale: u.locale,
    lang: u.lang,
    freqCorpusShort: u.freqCorpusShort,
    scrabbleLabel: u.scrabbleLabel,
    minWordLen: minLen,
    maxWordLen: maxLen,
  });
  renderPresentation(pres);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ao obter ${url}`);
  }
  return res.text();
}

async function loadDictionary() {
  currentLang = el.langSelect?.value === "en" ? "en" : "pt";
  const u = langUi();
  setStatus("A carregar dicionário e frequências…");
  el.btnLoad.disabled = true;
  try {
    const wordsUrl = currentLang === "en" ? WORDS_URL_EN : WORDS_URL_PT;
    const freqUrl = currentLang === "en" ? FREQUENCY_URL_EN : FREQUENCY_URL_PT;
    const [wordsText, freqText] = await Promise.all([fetchText(wordsUrl), fetchText(freqUrl)]);
    words = wordsText
      .split(/\r?\n/)
      .map((w) => w.trim())
      .filter(Boolean);
    freqMap = parseFrequencyCorpus(freqText);
    setStatus(
      `Pronto: ${words.length.toLocaleString(u.locale)} entradas; corpus ${currentLang === "en" ? "EN" : "PT"}.`
    );
    refreshLiveSearchIfPossible();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
    throw e;
  } finally {
    el.btnLoad.disabled = false;
  }
}

async function getTesseract() {
  if (!tesseractModule) {
    tesseractModule = await import(/* @vite-ignore */ TESSERACT_ESM);
  }
  return tesseractModule;
}

el.btnLoad.addEventListener("click", () => void loadDictionary());

el.langSelect?.addEventListener("change", () => {
  void loadDictionary();
});

for (const r of [el.wordLenMin, el.wordLenMax]) {
  r?.addEventListener("input", () => {
    syncWordLengthSliderOutputs();
    refreshLiveSearchIfPossible();
  });
}

el.btnOpenSuggestions.addEventListener("click", () => {
  openSuggestionsWindowFromUserGesture();
  setStatus("Janela de sugestões aberta ou focada. Redimensiona e move como qualquer janela.");
});

async function stopScreenCapture() {
  screenActive = false;
  lastBestSequenceLive = "";
  lastOcrBoundsKey = "";

  if (screenStream) {
    for (const track of screenStream.getTracks()) {
      track.stop();
    }
    screenStream = null;
  }

  el.screenPreview.srcObject = null;
  overlayDrag = null;
  el.screenPreviewWrap.classList.add("hidden");
  el.screenSelectionBox.hidden = true;
  el.screenStatus.textContent = "";
  el.screenOcrProgress.hidden = true;

  if (screenWorker) {
    try {
      await screenWorker.terminate();
    } catch {
      /* ignore */
    }
    screenWorker = null;
  }

  el.btnScreenStart.disabled = false;
  el.btnScreenStop.disabled = true;
}

async function screenOcrLoop() {
  const pollMs = () => clampNum(Number(el.screenPollMs.value), 400, 60_000);
  const maxW = () => clampNum(Number(el.screenMaxW.value), 320, 1920);

  let first = true;
  while (screenActive && screenWorker) {
    await sleep(first ? 250 : pollMs());
    first = false;
    if (!screenActive || !screenWorker) {
      break;
    }

    const crop = readCropPercents();
    const blob = await captureVideoFrameToBlob(el.screenPreview, maxW(), crop);
    if (!blob || !screenActive || !screenWorker) {
      continue;
    }

    try {
      el.screenOcrProgress.hidden = false;
      const { data } = await screenWorker.recognize(blob);
      if (!screenActive) {
        break;
      }

      const text = data.text ?? "";
      const candidates = extractCandidateSequences(text);
      const lenBounds = readWordLengthBoundsFromUi();
      const best = chooseBestSequence(words, candidates, freqMap, langUi().locale, lenBounds);

      if (!best) {
        el.screenStatus.textContent = "Nenhuma sequência válida neste frame…";
        continue;
      }

      const boundsKey = wordLengthBoundsKey();
      if (best === lastBestSequenceLive && boundsKey === lastOcrBoundsKey) {
        el.screenStatus.textContent = `Estável: ${best}`;
        continue;
      }

      lastBestSequenceLive = best;
      lastOcrBoundsKey = boundsKey;
      el.screenStatus.textContent = `Nova sequência: ${best}`;
      runSearch(best, true);
    } catch (e) {
      if (screenActive) {
        el.screenStatus.textContent =
          e instanceof Error ? e.message : "Erro no OCR do ecrã.";
      }
    } finally {
      el.screenOcrProgress.hidden = true;
    }
  }
}

el.btnScreenStart.addEventListener("click", async () => {
  if (!words.length) {
    setStatus("Carrega o dicionário primeiro.", true);
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Este browser não suporta partilha de ecrã (getDisplayMedia).", true);
    return;
  }

  el.btnScreenStart.disabled = true;
  el.screenStatus.textContent = "À espera da tua escolha no diálogo do browser…";

  try {
    /**
     * Ordem importante: `window.open()` antes de iniciar getDisplayMedia consome o gesto do utilizador e o Chrome
     * deixa de mostrar o picker de partilha. Iniciamos o pedido de ecrã primeiro; na mesma volta síncrona abrimos a
     * janela de sugestões; só depois fazemos await.
     */
    const displayMediaPromise = navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    openSuggestionsWindowFromUserGesture();

    const stream = await displayMediaPromise;

    screenStream = stream;
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) {
      throw new Error("Não foi obtida faixa de vídeo.");
    }

    videoTrack.addEventListener("ended", () => {
      void stopScreenCapture();
      setStatus("Partilha de ecrã terminada.");
    });

    el.screenPreview.srcObject = stream;
    await el.screenPreview.play();

    el.screenPreviewWrap.classList.remove("hidden");
    lastBestSequenceLive = "";
    lastOcrBoundsKey = "";
    requestAnimationFrame(() => {
      syncCropBoxVisual();
    });

    const { createWorker } = await getTesseract();
    screenWorker = await createWorker(langUi().ocrLanguages, 1, {
      logger: (m) => {
        if (m.status === "recognizing text" && typeof m.progress === "number") {
          el.screenOcrProgress.value = Math.round(m.progress * 100);
        }
      },
    });

    screenActive = true;
    el.btnScreenStop.disabled = false;
    el.screenStatus.textContent =
      "OCR contínuo ativo — arrasta na pré-visualização para a zona de OCR ou edita os %.";

    void screenOcrLoop();
  } catch (e) {
    let msg = String(e);
    if (e instanceof Error) {
      msg = e.name === "NotAllowedError" ? "Partilha cancelada ou negada." : e.message;
    }
    setStatus(msg, true);
    el.screenStatus.textContent = "";
    await stopScreenCapture();
  }
});

el.btnScreenStop.addEventListener("click", () => {
  void stopScreenCapture();
  setStatus("Partilha de ecrã parada.");
});

void (async () => {
  try {
    syncWordLengthSliderOutputs();
    await loadDictionary();
  } catch {
    /* mensagem já em setStatus */
  }
})();

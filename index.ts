import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import screenshot = require("screenshot-desktop");
import { PNG } from "pngjs";
import { createWorker, type Worker } from "tesseract.js";

const WORDS_URL =
  "https://raw.githubusercontent.com/pythonprobr/palavras/master/palavras.txt";
const CACHE_PATH = path.resolve(process.cwd(), "palavras-cache.txt");
/** Corpus PT: contagens em legendas (OpenSubtitles), projeto FrequencyWords (2018). */
const FREQUENCY_URL =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/pt/pt_full.txt";
const FREQUENCY_CACHE_PATH = path.resolve(process.cwd(), "freq-pt-opensubtitles-full.txt");
const MAX_RESULTS = 5;
const MAX_WORD_LENGTH = 8;
const OCR_POLL_MS = 1800;
const OCR_CHECK_INTERVAL_MS = 120;
const OCR_HOTKEY_DEBOUNCE_MS = 250;
const OCR_DEBUG_DIR = path.resolve(process.cwd(), "debug", "ocr");
const OVERLAY_SCRIPT_PATH = path.resolve(process.cwd(), "scripts/ocr_region_overlay.swift");
const MAIN_SCREEN_POINTS_SCRIPT_PATH = path.resolve(
  process.cwd(),
  "scripts/main_screen_points.swift"
);
const execFileAsync = promisify(execFile);
const LETTER_POINTS: Record<string, number> = {
  A: 1,
  B: 3,
  C: 2,
  D: 2,
  E: 1,
  F: 4,
  G: 4,
  H: 4,
  I: 1,
  J: 5,
  K: 10,
  L: 2,
  M: 1,
  N: 3,
  O: 1,
  P: 2,
  Q: 6,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 10,
  X: 8,
  Y: 10,
  Z: 8,
};
function normalize(value: string): string {
  return value.toUpperCase();
}

function normalizeLetters(value: string): string {
  return normalize(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isSimpleWord(word: string): boolean {
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]+$/u.test(word);
}

function getWordPoints(word: string): number {
  let total = 0;

  for (const letter of normalizeLetters(word)) {
    total += LETTER_POINTS[letter] ?? 0;
  }

  return total;
}

function downloadHttpsText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`Falha ao baixar recurso (HTTP ${response.statusCode}). URL: ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      })
      .on("error", (error) => {
        reject(new Error(`Erro de rede (${url}): ${error.message}`));
      });
  });
}

async function ensureCachedText(url: string, cachePath: string): Promise<string> {
  if (!fs.existsSync(cachePath)) {
    const downloaded = await downloadHttpsText(url);
    fs.writeFileSync(cachePath, downloaded, "utf-8");
  }

  return fs.readFileSync(cachePath, "utf-8");
}

async function getWordList(): Promise<string[]> {
  const content = await ensureCachedText(WORDS_URL, CACHE_PATH);
  return content
    .split(/\r?\n/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/** Chave para cruzar dicionário ↔ corpus (minúsculas, sem acento). */
function frequencyLookupKey(word: string): string {
  return normalizeLetters(word.toLowerCase());
}

function parseFrequencyCorpus(content: string): Map<string, number> {
  const map = new Map<string, number>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const lastSpace = line.lastIndexOf(" ");
    if (lastSpace <= 0) {
      continue;
    }

    const token = line.slice(0, lastSpace).trim();
    const freqRaw = line.slice(lastSpace + 1).trim().replace(/\u00a0/g, " ");
    const freq = Number(freqRaw.replace(/\s/g, ""));
    if (!token || !Number.isFinite(freq) || freq <= 0) {
      continue;
    }

    const key = frequencyLookupKey(token);
    const prev = map.get(key);
    if (prev === undefined || freq > prev) {
      map.set(key, freq);
    }
  }

  return map;
}

async function loadWordFrequencies(): Promise<Map<string, number>> {
  const content = await ensureCachedText(FREQUENCY_URL, FREQUENCY_CACHE_PATH);
  return parseFrequencyCorpus(content);
}

function getCorpusFrequency(word: string, freqMap: Map<string, number>): number {
  return freqMap.get(frequencyLookupKey(word)) ?? 0;
}

function sortMatchesByCorpus(matches: string[], freqMap: Map<string, number>): string[] {
  return [...matches].sort((a, b) => {
    const diff = getCorpusFrequency(b, freqMap) - getCorpusFrequency(a, freqMap);
    if (diff !== 0) {
      return diff;
    }

    return a.localeCompare(b, "pt-BR");
  });
}

function findMatchingWords(words: string[], sequence: string): string[] {
  const matches: string[] = [];
  const normalizedSequence = normalize(sequence);

  for (const word of words) {
    const normalizedWord = normalize(word);
    const hasCompoundSeparator =
      word.includes("-") || word.includes(" ") || word.includes("'");

    if (!normalizedWord.includes(normalizedSequence)) {
      continue;
    }

    if (word.length > MAX_WORD_LENGTH || hasCompoundSeparator || !isSimpleWord(word)) {
      continue;
    }

    matches.push(word);
  }

  return matches.sort((a, b) => b.length - a.length || a.localeCompare(b, "pt-BR"));
}

function highlightSequence(word: string, sequence: string): string {
  const upperWord = normalize(word);
  const upperSequence = normalize(sequence);
  const start = upperWord.indexOf(upperSequence);

  if (start === -1) {
    return word;
  }

  const end = start + sequence.length;
  return `${word.slice(0, start)}-${upperSequence}-${word.slice(end)}`;
}

function printResult(words: string[], sequence: string, freqMap: Map<string, number>): void {
  const matches = findMatchingWords(words, sequence);
  const sequenceUpper = normalize(sequence);

  if (matches.length === 0) {
    console.log(`Nenhuma palavra encontrada com a sequência "${sequenceUpper}"`);
    return;
  }

  console.log(`Sequência: ${sequenceUpper}`);
  console.log(`Encontradas: ${matches.length} palavra(s)\n`);

  const byCorpus = sortMatchesByCorpus(matches, freqMap);
  const pick = byCorpus[0];
  const pickFreq = getCorpusFrequency(pick, freqMap);

  console.log(
    "Melhor candidato por uso em português falado (corpus de legendas OpenSubtitles, FrequencyWords 2018):"
  );
  console.log(
    `→ ${normalize(pick)} (${highlightSequence(pick, sequenceUpper)}) — ` +
      (pickFreq > 0
        ? `~${pickFreq.toLocaleString("pt-BR")} ocorrências no corpus`
        : "sem ocorrência no corpus (palavra rara ou só no dicionário)")
  );

  const restByCorpus = byCorpus.slice(1, MAX_RESULTS);
  if (restByCorpus.length > 0) {
    console.log("\nOutras opções pelo mesmo critério:");
    for (const word of restByCorpus) {
      const f = getCorpusFrequency(word, freqMap);
      const freqLabel =
        f > 0 ? `~${f.toLocaleString("pt-BR")} no corpus` : "fora do corpus";
      console.log(
        `- ${normalize(word)} (${highlightSequence(word, sequenceUpper)}) — ${freqLabel}`
      );
    }
  }

  const highestPoints = [...matches]
    .sort((a, b) => {
      const scoreDiff = getWordPoints(b) - getWordPoints(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return a.localeCompare(b, "pt-BR");
    })
    .slice(0, MAX_RESULTS);

  console.log("\nTop 5 maior pontuação (Scrabble BR):");
  for (const word of highestPoints) {
    console.log(
      `- ${normalize(word)} (${highlightSequence(word, sequenceUpper)}) — ${getWordPoints(word)} pontos`
    );
  }
}

function extractCandidateSequences(text: string): string[] {
  const normalized = normalizeLetters(text);
  const rawTokens = normalized.match(/[A-Z]{2,5}/g) ?? [];
  const unique = new Set<string>();

  for (const token of rawTokens) {
    unique.add(token);
  }

  return [...unique];
}

function chooseBestSequence(
  words: string[],
  candidates: string[],
  freqMap: Map<string, number>
): string | null {
  let best: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const matches = findMatchingWords(words, candidate);
    if (matches.length === 0) {
      continue;
    }

    const topWord = sortMatchesByCorpus(matches, freqMap)[0];
    const freq = getCorpusFrequency(topWord, freqMap);
    const score = freq * 1_000_000 + matches.length * 100 + getWordPoints(topWord);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

type OcrRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Largura da tela principal em pontos (overlay); usado para escalar até pixels da captura Retina. */
  screenWidth?: number;
  /** Altura da tela principal em pontos. */
  screenHeight?: number;
};

function formatRegion(region: OcrRegion): string {
  return `left=${region.left}, top=${region.top}, width=${region.width}, height=${region.height}`;
}

async function readMainScreenPoints(): Promise<{ width: number; height: number } | null> {
  if (process.platform !== "darwin" || !fs.existsSync(MAIN_SCREEN_POINTS_SCRIPT_PATH)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("swift", [MAIN_SCREEN_POINTS_SCRIPT_PATH], {
      encoding: "utf8",
      maxBuffer: 256,
    });
    const parts = stdout.trim().split(/\s+/);
    if (parts.length < 2) {
      return null;
    }

    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  } catch {
    return null;
  }
}

async function withScreenDimensions(region: OcrRegion): Promise<OcrRegion> {
  const dims = await readMainScreenPoints();
  if (!dims) {
    return region;
  }

  return { ...region, screenWidth: dims.width, screenHeight: dims.height };
}

/**
 * Converte retângulo em pontos (overlay) para pixels da imagem capturada.
 * Sem screenWidth/screenHeight, assume que left/top/width/height já estão em pixels do PNG.
 */
function regionRectInImagePixels(region: OcrRegion, pngWidth: number, pngHeight: number): OcrRegion {
  if (
    region.screenWidth === undefined ||
    region.screenHeight === undefined ||
    region.screenWidth <= 0 ||
    region.screenHeight <= 0
  ) {
    return region;
  }

  const sx = pngWidth / region.screenWidth;
  const sy = pngHeight / region.screenHeight;
  return {
    left: Math.round(region.left * sx),
    top: Math.round(region.top * sy),
    width: Math.round(region.width * sx),
    height: Math.round(region.height * sy),
    screenWidth: region.screenWidth,
    screenHeight: region.screenHeight,
  };
}

/** Recorta o PNG para o retângulo da região (após escala pontos → pixels, se aplicável). */
function cropPngToRegion(fullPng: Buffer, region: OcrRegion): Buffer {
  const src = PNG.sync.read(fullPng);
  const rect = regionRectInImagePixels(region, src.width, src.height);
  const left = Math.min(Math.max(0, rect.left), Math.max(0, src.width - 1));
  const top = Math.min(Math.max(0, rect.top), Math.max(0, src.height - 1));
  const width = Math.min(rect.width, src.width - left);
  const height = Math.min(rect.height, src.height - top);

  if (width <= 0 || height <= 0) {
    throw new Error(
      `Regiao fora da imagem (${formatRegion(region)} → ${formatRegion(rect)} em ${src.width}x${src.height}).`
    );
  }

  const dst = new PNG({ width, height });
  PNG.bitblt(src, dst, left, top, width, height, 0, 0);
  return PNG.sync.write(dst);
}

function bufferForOcr(fullScreenshot: Buffer, region: OcrRegion | null): Buffer {
  if (!region) {
    return fullScreenshot;
  }

  return cropPngToRegion(fullScreenshot, region);
}

async function waitForNextCycle(
  delayMs: number,
  shouldInterrupt: () => boolean
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    if (shouldInterrupt()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, OCR_CHECK_INTERVAL_MS));
  }
}

async function askPositiveInteger(
  rl: readline.Interface,
  label: string,
  currentValue?: number
): Promise<number> {
  while (true) {
    const suffix = currentValue !== undefined ? ` [atual: ${currentValue}]` : "";
    const raw = (await askQuestion(rl, `${label}${suffix}: `)).trim();
    const effectiveValue = raw || (currentValue !== undefined ? String(currentValue) : "");
    const parsed = Number(effectiveValue);

    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }

    console.log("Valor invalido. Informe um numero inteiro maior ou igual a zero.");
  }
}

async function promptForRegionManual(currentRegion: OcrRegion | null): Promise<OcrRegion | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const help = currentRegion
      ? `Regiao atual: ${formatRegion(currentRegion)}`
      : "Nenhuma regiao definida.";
    console.log(help);
    const keepAll = normalize(await askQuestion(rl, 'Pressione Enter para definir regiao, ou digite "tela" para usar tela inteira: ')).trim();
    if (keepAll === "TELA") {
      return null;
    }

    const left = await askPositiveInteger(rl, "left", currentRegion?.left);
    const top = await askPositiveInteger(rl, "top", currentRegion?.top);
    const width = await askPositiveInteger(rl, "width", currentRegion?.width);
    const height = await askPositiveInteger(rl, "height", currentRegion?.height);

    if (width === 0 || height === 0) {
      console.log("Width e height precisam ser maiores que zero. Mantendo configuracao anterior.");
      return currentRegion;
    }

    return await withScreenDimensions({ left, top, width, height });
  } finally {
    rl.close();
  }
}

async function promptForRegionOverlay(
  currentRegion: OcrRegion | null
): Promise<OcrRegion | null> {
  if (!fs.existsSync(OVERLAY_SCRIPT_PATH)) {
    throw new Error(`Script de overlay nao encontrado em ${OVERLAY_SCRIPT_PATH}`);
  }

  return new Promise((resolve, reject) => {
    const args = [OVERLAY_SCRIPT_PATH];
    if (currentRegion) {
      args.push(
        "--left",
        String(currentRegion.left),
        "--top",
        String(currentRegion.top),
        "--width",
        String(currentRegion.width),
        "--height",
        String(currentRegion.height)
      );
    }

    const processRef = spawn("swift", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    processRef.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    processRef.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    processRef.on("error", (error) => {
      reject(new Error(`Falha ao abrir overlay: ${error.message}`));
    });

    processRef.on("close", (code) => {
      const output = stdout.trim();
      if (code !== 0) {
        const details = stderr.trim() || output || `codigo ${code}`;
        reject(new Error(`Overlay encerrou com erro: ${details}`));
        return;
      }

      if (!output || output === "CANCELLED") {
        resolve(currentRegion);
        return;
      }

      if (output === "FULLSCREEN") {
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(output) as OcrRegion;
        if (parsed.width <= 0 || parsed.height <= 0) {
          resolve(currentRegion);
          return;
        }
        resolve(parsed);
      } catch (_error) {
        reject(new Error(`Resposta invalida do overlay: "${output}"`));
      }
    });
  });
}

async function promptForRegion(currentRegion: OcrRegion | null): Promise<OcrRegion | null> {
  try {
    return await promptForRegionOverlay(currentRegion);
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.log(`Overlay indisponivel (${message}). Usando configuracao manual.`);
    return await promptForRegionManual(currentRegion);
  }
}

async function runInteractive(words: string[], freqMap: Map<string, number>): Promise<void> {
  console.log('Modo interativo: digite uma sequência e pressione Enter.');
  console.log('Para sair, digite "sair", "q" ou "exit".\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const answer = (await askQuestion(rl, "Sequência> ")).trim();
    const command = normalize(answer);

    if (command === "SAIR" || command === "Q" || command === "EXIT") {
      rl.close();
      console.log("Encerrando.");
      return;
    }

    if (!answer) {
      continue;
    }

    printResult(words, answer, freqMap);
    console.log("");
  }
}

async function runOcrMode(words: string[], freqMap: Map<string, number>): Promise<void> {
  console.log("Modo OCR iniciado.");
  console.log("Conceda permissão de gravação de tela para o terminal/IDE no macOS.");
  console.log("Controles:");
  console.log("- s: forcar screenshot imediato");
  console.log("- r: abrir overlay para selecionar/redimensionar regiao");
  console.log("- a: voltar para tela inteira");
  console.log("- Ctrl+C: encerrar\n");

  const worker: Worker = await createWorker("por+eng");
  let lastBestSequence = "";
  let activeRegion: OcrRegion | null = null;
  let forceScreenshot = true;
  let isConfiguringRegion = false;
  let shouldStop = false;
  let manualScreenshotRequested = false;
  const hotkeyLastAt: Partial<Record<"s" | "a" | "r", number>> = {};

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const keypressHandler = (_str: string, key: readline.Key) => {
    const isDebouncedHotkey = (hotkey: "s" | "a" | "r"): boolean => {
      const now = Date.now();
      const lastAt = hotkeyLastAt[hotkey] ?? 0;
      if (now - lastAt < OCR_HOTKEY_DEBOUNCE_MS) {
        return true;
      }
      hotkeyLastAt[hotkey] = now;
      return false;
    };

    if (key.ctrl && key.name === "c") {
      shouldStop = true;
      return;
    }

    if (key.name === "s") {
      if (isDebouncedHotkey("s")) {
        return;
      }
      forceScreenshot = true;
      manualScreenshotRequested = true;
      console.log("\nScreenshot manual solicitado.");
      return;
    }

    if (key.name === "a") {
      if (isDebouncedHotkey("a")) {
        return;
      }
      activeRegion = null;
      forceScreenshot = true;
      console.log("\nOCR configurado para usar tela inteira.");
      return;
    }

    if (key.name === "r") {
      if (isDebouncedHotkey("r")) {
        return;
      }
      if (isConfiguringRegion) {
        return;
      }

      isConfiguringRegion = true;
      forceScreenshot = true;
      void (async () => {
        try {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          console.log("\nConfiguracao de regiao:");
          const selectedRegion = await promptForRegion(activeRegion);
          activeRegion = selectedRegion;
          if (activeRegion) {
            console.log(`Regiao atualizada: ${formatRegion(activeRegion)}`);
          } else {
            console.log("Regiao removida. OCR usando tela inteira.");
          }
        } finally {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          isConfiguringRegion = false;
          forceScreenshot = true;
        }
      })();
    }
  };

  process.stdin.on("keypress", keypressHandler);

  while (!shouldStop) {
    try {
      if (isConfiguringRegion) {
        await new Promise((resolve) => setTimeout(resolve, OCR_CHECK_INTERVAL_MS));
        continue;
      }

      const fullCapture = await screenshot({ format: "png" });
      const image = bufferForOcr(fullCapture, activeRegion);
      if (manualScreenshotRequested) {
        try {
          fs.mkdirSync(OCR_DEBUG_DIR, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const suffix = activeRegion ? "region" : "fullscreen";
          const filePath = path.join(OCR_DEBUG_DIR, `ocr-shot-${suffix}-${timestamp}.png`);
          fs.writeFileSync(filePath, image);
          console.log(`Screenshot salvo para debug: ${filePath}`);
          const preview = spawn("open", [filePath], { stdio: "ignore" });
          preview.on("error", () => {
            console.log("Nao foi possivel abrir automaticamente no Preview.");
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "erro desconhecido";
          console.log(`Falha ao salvar screenshot de debug: ${message}`);
        }
      }
      const result = await worker.recognize(image);
      const candidates = extractCandidateSequences(result.data.text);
      const bestSequence = chooseBestSequence(words, candidates, freqMap);

      if (!bestSequence) {
        if (manualScreenshotRequested) {
          console.log("\nNenhuma sequencia valida detectada na regiao atual.");
          console.log("Dica: ajuste a regiao (tecla r) ou tente tela inteira (tecla a).\n");
        }
        manualScreenshotRequested = false;
        forceScreenshot = false;
        await waitForNextCycle(OCR_POLL_MS, () => forceScreenshot || shouldStop);
        continue;
      }

      if (bestSequence === lastBestSequence && !manualScreenshotRequested) {
        forceScreenshot = false;
        await waitForNextCycle(OCR_POLL_MS, () => forceScreenshot || shouldStop);
        continue;
      }

      lastBestSequence = bestSequence;
      if (manualScreenshotRequested) {
        console.log(`\nDetectado manualmente: ${bestSequence}`);
      } else {
        console.log(`\nDetectado automaticamente: ${bestSequence}`);
      }
      printResult(words, bestSequence, freqMap);
      console.log("");
      manualScreenshotRequested = false;
      forceScreenshot = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha no OCR.";
      console.error(`Erro no OCR: ${message}`);
      forceScreenshot = false;
      await waitForNextCycle(OCR_POLL_MS, () => forceScreenshot || shouldStop);
    }
  }

  process.stdin.off("keypress", keypressHandler);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  await worker.terminate();
  console.log("\nEncerrando OCR.");
}

async function main(): Promise<void> {
  try {
    const [words, freqMap] = await Promise.all([getWordList(), loadWordFrequencies()]);
    const arg = process.argv[2]?.trim();

    if (arg === "--ocr") {
      await runOcrMode(words, freqMap);
      return;
    }

    if (arg) {
      printResult(words, arg, freqMap);
      return;
    }

    await runInteractive(words, freqMap);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    console.error(message);
    process.exit(1);
  }
}

void main();

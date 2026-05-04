import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as readline from "readline";
import screenshot = require("screenshot-desktop");
import { PNG } from "pngjs";
import { createWorker, type Worker } from "tesseract.js";

const WORDS_URL_PT =
  "https://raw.githubusercontent.com/pythonprobr/palavras/master/palavras.txt";
const CACHE_PATH_PT = path.resolve(process.cwd(), "palavras-cache.txt");
/** Lista EN: apenas letras a–z (dwyl/english-words). */
const WORDS_URL_EN =
  "https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt";
const CACHE_PATH_EN = path.resolve(process.cwd(), "words-en-alpha-cache.txt");
/** Corpus PT: contagens em legendas (OpenSubtitles), projeto FrequencyWords (2018). */
const FREQUENCY_URL_PT =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/pt/pt_full.txt";
const FREQUENCY_CACHE_PATH_PT = path.resolve(process.cwd(), "freq-pt-opensubtitles-full.txt");
/** Corpus EN: mesmo projeto, legendas EN (2018). */
const FREQUENCY_URL_EN =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt";
const FREQUENCY_CACHE_PATH_EN = path.resolve(process.cwd(), "freq-en-opensubtitles-full.txt");

type WordLang = "pt" | "en";

type LangRuntime = {
  lang: WordLang;
  locale: string;
  wordsUrl: string;
  wordsCachePath: string;
  frequencyUrl: string;
  frequencyCachePath: string;
  freqCorpusShort: string;
  scrabbleLabel: string;
  ocrLanguages: string;
};

function getLangRuntime(lang: WordLang): LangRuntime {
  if (lang === "en") {
    return {
      lang: "en",
      locale: "en-US",
      wordsUrl: WORDS_URL_EN,
      wordsCachePath: CACHE_PATH_EN,
      frequencyUrl: FREQUENCY_URL_EN,
      frequencyCachePath: FREQUENCY_CACHE_PATH_EN,
      freqCorpusShort: "FrequencyWords / OpenSubtitles EN",
      scrabbleLabel: "Scrabble (EN / international tiles)",
      ocrLanguages: "eng",
    };
  }

  return {
    lang: "pt",
    locale: "pt-BR",
    wordsUrl: WORDS_URL_PT,
    wordsCachePath: CACHE_PATH_PT,
    frequencyUrl: FREQUENCY_URL_PT,
    frequencyCachePath: FREQUENCY_CACHE_PATH_PT,
    freqCorpusShort: "FrequencyWords / legendas PT",
    scrabbleLabel: "Scrabble BR",
    ocrLanguages: "por+eng",
  };
}
const MAX_RESULTS = 5;
/** Comprimento máximo de cada entrada do dicionário. */
const MAX_WORD_LENGTH = 15;
/** Permite hífen entre grupos de letras (ex.: beija-flores). */
const ALLOW_HYPHEN_IN_LEXEME = false;
/** Permite apóstrofo entre grupos de letras (ex.: d'água). */
const ALLOW_APOSTROPHE_IN_LEXEME = true;
const OCR_POLL_MS = 500;
const OCR_CHECK_INTERVAL_MS = 120;
const OCR_HOTKEY_DEBOUNCE_MS = 250;
/** Pausa média antes de começar a digitar (para focares o campo do jogo). */
const OCR_PASTE_DELAY_MS = 500;
/** Variação aleatória ± este valor na pausa inicial (mais natural). */
const OCR_TYPING_FOCUS_JITTER_MS = 280;
/** Pausa mínima aleatória entre carateres. */
const OCR_KEYSTROKE_GAP_MS_MIN = 100;
/** Pausa máxima aleatória entre carateres. */
const OCR_KEYSTROKE_GAP_MS_MAX = 130;
/** Probabilidade de uma hesitação extra entre duas teclas (pausa mais longa). */
const OCR_TYPING_HESITATION_CHANCE = 0.07;
const OCR_TYPING_HESITATION_MS_MIN = 110;
const OCR_TYPING_HESITATION_MS_MAX = 480;
/** Probabilidade de carácter errado antes do certo (só letras); corrige com backspace. */
const OCR_TYPING_TYPO_CHANCE = 0.038;
const OCR_TYPING_TYPO_PAUSE_MS_MIN = 42;
const OCR_TYPING_TYPO_PAUSE_MS_MAX = 210;
/** Probabilidade de apagar os últimos N carateres e voltar a escrevê-los. */
const OCR_TYPING_REDO_SUFFIX_CHANCE = 0.022;
/** Máximo de carateres a apagar ao refazer um sufixo (mínimo efectivo 2). */
const OCR_TYPING_REDO_SUFFIX_MAX = 7;
/** Pausa entre backspaces ao apagar. */
const OCR_TYPING_BACKSPACE_GAP_MS_MIN = 26;
const OCR_TYPING_BACKSPACE_GAP_MS_MAX = 88;
/** Probabilidade rara de apagar a palavra toda já escrita e digitar outra vez desde o início. */
const OCR_TYPING_RESTART_FROM_SCRATCH_CHANCE = 0.009;
const OCR_DEBUG_DIR = path.resolve(process.cwd(), "debug", "ocr");
/** Preferência local da última região OCR (modo overlay/manual); não versionado por defeito. */
const OCR_REGION_SAVE_PATH = path.resolve(process.cwd(), "ocr-region.json");
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

/** Uma só palavra: só letras Unicode, sem `-` nem `'`. */
function isSimpleWordLexeme(word: string): boolean {
  return /^[\p{L}]+$/u.test(word);
}

/** Composto conforme constantes `ALLOW_HYPHEN_IN_LEXEME` / `ALLOW_APOSTROPHE_IN_LEXEME`. Sem espaços. */
function isCompoundLexemeByFlags(word: string): boolean {
  if (word.includes(" ") || word.includes("--")) {
    return false;
  }

  const hyp = ALLOW_HYPHEN_IN_LEXEME;
  const apo = ALLOW_APOSTROPHE_IN_LEXEME;

  if (hyp && apo) {
    return /^[\p{L}]+(?:[-'][\p{L}]+)*$/u.test(word);
  }

  if (hyp && !apo) {
    if (word.includes("'")) {
      return false;
    }

    return /^[\p{L}]+(?:-[\p{L}]+)*$/u.test(word);
  }

  if (!hyp && apo) {
    if (word.includes("-")) {
      return false;
    }

    return /^[\p{L}]+(?:'[\p{L}]+)*$/u.test(word);
  }

  return isSimpleWordLexeme(word);
}

function isAllowedLexeme(word: string): boolean {
  if (!ALLOW_HYPHEN_IN_LEXEME && !ALLOW_APOSTROPHE_IN_LEXEME) {
    return isSimpleWordLexeme(word);
  }

  return isCompoundLexemeByFlags(word);
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

async function getWordList(rt: LangRuntime): Promise<string[]> {
  const content = await ensureCachedText(rt.wordsUrl, rt.wordsCachePath);
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

async function loadWordFrequencies(rt: LangRuntime): Promise<Map<string, number>> {
  const content = await ensureCachedText(rt.frequencyUrl, rt.frequencyCachePath);
  return parseFrequencyCorpus(content);
}

function getCorpusFrequency(word: string, freqMap: Map<string, number>): number {
  return freqMap.get(frequencyLookupKey(word)) ?? 0;
}

/**
 * Para jogar: prioriza palavras mais longas que contêm a sequência (máxima extensão no dicionário);
 * entre empates, prefere maior frequência no corpus.
 */
function sortMatchesByLengthThenCorpus(
  matches: string[],
  freqMap: Map<string, number>,
  locale: string
): string[] {
  return [...matches].sort((a, b) => {
    const lenDiff = b.length - a.length;
    if (lenDiff !== 0) {
      return lenDiff;
    }

    const freqDiff = getCorpusFrequency(b, freqMap) - getCorpusFrequency(a, freqMap);
    if (freqDiff !== 0) {
      return freqDiff;
    }

    return a.localeCompare(b, locale);
  });
}

type LengthTier = "short" | "medium" | "long";

/** Pesos relativos ao escolher faixa de comprimento (modo OCR “humano”). */
const LENGTH_TIER_WEIGHTS: Record<LengthTier, number> = {
  short: 0.18,
  medium: 0.32,
  long: 0.5,
};

function lengthTierForWord(len: number, minLen: number, maxLen: number): LengthTier {
  if (maxLen <= minLen) {
    return "medium";
  }

  const span = maxLen - minLen || 1;
  const t = (len - minLen) / span;
  if (t < 1 / 3) {
    return "short";
  }

  if (t < 2 / 3) {
    return "medium";
  }

  return "long";
}

function bucketMatchesByLengthTier(matches: string[]): Record<LengthTier, string[]> {
  const buckets: Record<LengthTier, string[]> = { short: [], medium: [], long: [] };
  const lengths = matches.map((w) => w.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);

  for (const w of matches) {
    buckets[lengthTierForWord(w.length, minLen, maxLen)].push(w);
  }

  return buckets;
}

function sortMatchesByCorpusThenLocale(
  matches: string[],
  freqMap: Map<string, number>,
  locale: string
): string[] {
  return [...matches].sort((a, b) => {
    const freqDiff = getCorpusFrequency(b, freqMap) - getCorpusFrequency(a, freqMap);
    if (freqDiff !== 0) {
      return freqDiff;
    }

    return a.localeCompare(b, locale);
  });
}

/** Lista já ordenada por corpus; escolhe ao acaso uma das primeiras até `poolMax` entradas. */
function pickRandomFromCorpusWeightedPool(sortedByCorpus: string[], poolMax: number): string {
  const n = sortedByCorpus.length;
  const poolSize = Math.min(poolMax, n);
  const idx = Math.floor(Math.random() * poolSize);
  return sortedByCorpus[idx];
}

function weightedRandomAmongTiers(nonEmptyTiers: LengthTier[]): LengthTier {
  let sum = 0;
  const weights: number[] = [];

  for (const tier of nonEmptyTiers) {
    const w = LENGTH_TIER_WEIGHTS[tier];
    weights.push(w);
    sum += w;
  }

  let r = Math.random() * sum;
  for (let i = 0; i < nonEmptyTiers.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      return nonEmptyTiers[i];
    }
  }

  return nonEmptyTiers[nonEmptyTiers.length - 1];
}

/**
 * Classifica matches por comprimento relativo (terços entre min e max neste conjunto),
 * escolhe uma faixa com pesos fixos e dentro dela uma palavra ao acaso entre as mais frequentes no corpus.
 */
function pickPlayWordHumanTiered(
  matches: string[],
  freqMap: Map<string, number>,
  locale: string
): { word: string; tier: LengthTier } {
  if (matches.length === 1) {
    return { word: matches[0], tier: "medium" };
  }

  const buckets = bucketMatchesByLengthTier(matches);
  const tierOrder: LengthTier[] = ["short", "medium", "long"];
  const nonEmpty = tierOrder.filter((t) => buckets[t].length > 0);

  const tier =
    nonEmpty.length === 1 ? nonEmpty[0] : weightedRandomAmongTiers(nonEmpty);
  const ranked = sortMatchesByCorpusThenLocale(buckets[tier], freqMap, locale);

  return { word: pickRandomFromCorpusWeightedPool(ranked, 5), tier };
}

function findMatchingWords(words: string[], sequence: string, locale: string): string[] {
  const matches: string[] = [];
  const normalizedSequence = normalize(sequence);

  for (const word of words) {
    const normalizedWord = normalize(word);

    if (!normalizedWord.includes(normalizedSequence)) {
      continue;
    }

    if (word.length > MAX_WORD_LENGTH || !isAllowedLexeme(word)) {
      continue;
    }

    matches.push(word);
  }

  return matches.sort((a, b) => b.length - a.length || a.localeCompare(b, locale));
}

/** Simula digitação real carácter a carácter (sem clipboard nem Cmd+V). macOS / JXA. */
async function typeRecommendedWordIntoFocusedApp(word: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Digitação simulada só está disponível no macOS.");
  }

  const focusMs = Math.round(
    Math.max(
      450,
      OCR_PASTE_DELAY_MS + (Math.random() * 2 - 1) * OCR_TYPING_FOCUS_JITTER_MS
    )
  );

  console.log(
    `\nEm ~${(focusMs / 1000).toFixed(1)}s começa a digitação — foca já o campo de texto do ` +
      `jogo. (Privacidade e segurança → Acessibilidade para o Terminal ou Cursor.)`
  );
  await new Promise((resolve) => setTimeout(resolve, focusMs));

  const gapMin = OCR_KEYSTROKE_GAP_MS_MIN;
  const gapMax = OCR_KEYSTROKE_GAP_MS_MAX;
  const hesitateChance = OCR_TYPING_HESITATION_CHANCE;
  const hesitateMin = OCR_TYPING_HESITATION_MS_MIN;
  const hesitateMax = OCR_TYPING_HESITATION_MS_MAX;
  const typoChance = OCR_TYPING_TYPO_CHANCE;
  const typoPauseMin = OCR_TYPING_TYPO_PAUSE_MS_MIN;
  const typoPauseMax = OCR_TYPING_TYPO_PAUSE_MS_MAX;
  const redoSuffixChance = OCR_TYPING_REDO_SUFFIX_CHANCE;
  const redoSuffixMax = OCR_TYPING_REDO_SUFFIX_MAX;
  const bsGapMin = OCR_TYPING_BACKSPACE_GAP_MS_MIN;
  const bsGapMax = OCR_TYPING_BACKSPACE_GAP_MS_MAX;
  const restartChance = OCR_TYPING_RESTART_FROM_SCRATCH_CHANCE;

  const script = `
    function sleepMs(ms) {
      var end = Date.now() + ms;
      while (Date.now() < end) {}
    }
    function randInt(a, b) {
      return Math.floor(Math.random() * (b - a + 1)) + a;
    }
    var se = Application('System Events');
    function backspaceOnce() {
      se.keyCode(51);
    }
    function pauseBetweenKeys() {
      var pause = randInt(${gapMin}, ${gapMax});
      if (Math.random() < ${hesitateChance}) {
        pause += randInt(${hesitateMin}, ${hesitateMax});
      }
      sleepMs(pause);
    }
    function randomWrongLetter(ch) {
      var pool = "AEIOUBCDFGHJKLMNPQRSTUVWXYZ";
      var chUp = ch.toUpperCase();
      var wantUpper = ch === chUp;
      var pick = chUp;
      var guard = 0;
      while (pick === chUp && guard++ < 24) {
        pick = pool.charAt(randInt(0, pool.length - 1));
      }
      return wantUpper ? pick : pick.toLowerCase();
    }
    function isLetterLike(ch) {
      return /^\\p{L}$/u.test(ch);
    }
    function maybeTypoThenCorrect(ch) {
      if (${typoChance} > 0 && isLetterLike(ch) && Math.random() < ${typoChance}) {
        se.keystroke(randomWrongLetter(ch));
        sleepMs(randInt(${typoPauseMin}, ${typoPauseMax}));
        backspaceOnce();
        sleepMs(randInt(${typoPauseMin}, ${typoPauseMax}));
      }
      se.keystroke(ch);
    }
    var s = ${JSON.stringify(word)};
    var i = 0;
    for (i = 0; i < s.length; i++) {
      if (i >= 7 && ${restartChance} > 0 && Math.random() < ${restartChance}) {
        var rb = 0;
        for (rb = 0; rb < i; rb++) {
          backspaceOnce();
          sleepMs(randInt(${bsGapMin}, ${bsGapMax}));
        }
        sleepMs(randInt(${hesitateMin}, ${hesitateMax}));
        var rj = 0;
        for (rj = 0; rj < i; rj++) {
          maybeTypoThenCorrect(s.charAt(rj));
          if (rj < i - 1) pauseBetweenKeys();
        }
        pauseBetweenKeys();
      }
      if (i >= 4 && ${redoSuffixChance} > 0 && Math.random() < ${redoSuffixChance}) {
        var redoLen = randInt(2, Math.min(${redoSuffixMax}, i));
        var bk = 0;
        for (bk = 0; bk < redoLen; bk++) {
          backspaceOnce();
          sleepMs(randInt(${bsGapMin}, ${bsGapMax}));
        }
        sleepMs(randInt(75, 260));
        var jj = 0;
        for (jj = i - redoLen; jj < i; jj++) {
          maybeTypoThenCorrect(s.charAt(jj));
          if (jj < i - 1) pauseBetweenKeys();
        }
        pauseBetweenKeys();
      }
      maybeTypoThenCorrect(s.charAt(i));
      if (i < s.length - 1) pauseBetweenKeys();
    }
  `;

  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
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

type PrintResultOptions = {
  /** Modo OCR: escolha variada entre faixas curtas/médias/longas (relativo ao conjunto de matches). */
  humanTierWordPick?: boolean;
};

/** Devolve exatamente o texto da recomendação principal (maiúsculas, como na linha `→`), ou null se não houver matches. */
function printResult(
  words: string[],
  sequence: string,
  freqMap: Map<string, number>,
  rt: LangRuntime,
  options?: PrintResultOptions
): string | null {
  const { locale, lang, freqCorpusShort, scrabbleLabel } = rt;
  const matches = findMatchingWords(words, sequence, locale);
  const sequenceUpper = normalize(sequence);

  if (matches.length === 0) {
    console.log(`Nenhuma palavra encontrada com a sequência "${sequenceUpper}"`);
    return null;
  }

  console.log(`Sequência: ${sequenceUpper}`);
  console.log(`Encontradas: ${matches.length} palavra(s)\n`);

  const sortedForPlay = sortMatchesByLengthThenCorpus(matches, freqMap, locale);

  let pick: string;
  let criterionNote: string;

  if (options?.humanTierWordPick) {
    const { word, tier } = pickPlayWordHumanTiered(matches, freqMap, locale);
    pick = word;
    if (lang === "en") {
      const tierEn =
        tier === "short" ? "short length band" : tier === "medium" ? "medium length band" : "long length band";
      criterionNote =
        `OCR mode: among possible lengths for this sequence, a ${tierEn} was picked at random; ` +
        `within it, a random word among the ~5 most frequent in the corpus`;
    } else {
      const tierPt =
        tier === "short"
          ? "faixa curta"
          : tier === "medium"
            ? "faixa média"
            : "faixa longa";
      criterionNote =
        `modo OCR (mais natural): entre os comprimentos possíveis para esta sequência foi sorteada a ${tierPt}; ` +
        `dentro dela, palavra aleatória entre as ~5 mais frequentes no corpus`;
    }
  } else {
    pick = sortedForPlay[0];
    criterionNote =
      lang === "en"
        ? `longest dictionary word containing the sequence; ties broken by corpus frequency — ${freqCorpusShort}`
        : `palavra mais longa no dicionário que contém a sequência; empate por uso no corpus — ${freqCorpusShort}`;
  }

  const pickShown = normalize(pick);
  const pickFreq = getCorpusFrequency(pick, freqMap);
  const lenUnit = lang === "en" ? "letters" : "letras";
  const ptsUnit = lang === "en" ? "points" : "pontos";
  const inCorpus =
    lang === "en"
      ? pickFreq > 0
        ? `; ~${pickFreq.toLocaleString(locale)} in corpus`
        : "; not attested in corpus"
      : pickFreq > 0
        ? `; ~${pickFreq.toLocaleString(locale)} no corpus`
        : "; sem ocorrência no corpus";

  console.log(
    lang === "en"
      ? `Best candidate (${criterionNote}):`
      : `Melhor candidato (${criterionNote}):`
  );
  console.log(
    `→ ${pickShown} (${highlightSequence(pick, sequenceUpper)}) — ${pick.length} ${lenUnit}${inCorpus}`
  );

  const restForPlay = sortedForPlay.filter((w) => w !== pick).slice(0, MAX_RESULTS);
  if (restForPlay.length > 0) {
    console.log(
      lang === "en"
        ? "\nOther options by the same rule (length, then corpus):"
        : "\nOutras opções pelo mesmo critério (comprimento, depois corpus):"
    );
    for (const word of restForPlay) {
      const f = getCorpusFrequency(word, freqMap);
      const freqLabel =
        lang === "en"
          ? f > 0
            ? `~${f.toLocaleString(locale)} in corpus`
            : "not in corpus"
          : f > 0
            ? `~${f.toLocaleString(locale)} no corpus`
            : "fora do corpus";
      console.log(
        `- ${normalize(word)} (${highlightSequence(word, sequenceUpper)}) — ${word.length} ${lenUnit}; ${freqLabel}`
      );
    }
  }

  const highestPoints = [...matches]
    .sort((a, b) => {
      const scoreDiff = getWordPoints(b) - getWordPoints(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return a.localeCompare(b, locale);
    })
    .slice(0, MAX_RESULTS);

  console.log(
    lang === "en"
      ? `\nTop 5 by tile score (${scrabbleLabel}):`
      : `\nTop 5 maior pontuação (${scrabbleLabel}):`
  );
  for (const word of highestPoints) {
    console.log(
      `- ${normalize(word)} (${highlightSequence(word, sequenceUpper)}) — ${getWordPoints(word)} ${ptsUnit}`
    );
  }

  return pickShown;
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
  freqMap: Map<string, number>,
  locale: string
): string | null {
  let best: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const matches = findMatchingWords(words, candidate, locale);
    if (matches.length === 0) {
      continue;
    }

    const topWord = sortMatchesByLengthThenCorpus(matches, freqMap, locale)[0];
    const freq = getCorpusFrequency(topWord, freqMap);
    const score =
      topWord.length * 1e15 +
      freq * 1_000_000 +
      matches.length * 100 +
      getWordPoints(topWord);
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

function parseSavedOcrRegion(data: unknown): OcrRegion | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const o = data as Record<string, unknown>;
  const left = Math.round(Number(o.left));
  const top = Math.round(Number(o.top));
  const width = Math.round(Number(o.width));
  const height = Math.round(Number(o.height));

  const nums = [left, top, width, height];
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) {
    return null;
  }

  if (width <= 0 || height <= 0) {
    return null;
  }

  const region: OcrRegion = { left, top, width, height };
  const sw = Number(o.screenWidth);
  const sh = Number(o.screenHeight);
  if (Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0) {
    region.screenWidth = Math.round(sw);
    region.screenHeight = Math.round(sh);
  }

  return region;
}

function loadSavedOcrRegion(): OcrRegion | null {
  try {
    if (!fs.existsSync(OCR_REGION_SAVE_PATH)) {
      return null;
    }

    const raw = JSON.parse(fs.readFileSync(OCR_REGION_SAVE_PATH, "utf8")) as unknown;
    return parseSavedOcrRegion(raw);
  } catch {
    return null;
  }
}

function persistOcrRegion(region: OcrRegion | null): void {
  try {
    if (!region) {
      if (fs.existsSync(OCR_REGION_SAVE_PATH)) {
        fs.unlinkSync(OCR_REGION_SAVE_PATH);
      }
      return;
    }

    fs.writeFileSync(OCR_REGION_SAVE_PATH, `${JSON.stringify(region)}\n`, "utf8");
  } catch {
    /* disco só de leitura ou permissões */
  }
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

async function runInteractive(
  words: string[],
  freqMap: Map<string, number>,
  rt: LangRuntime
): Promise<void> {
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

    printResult(words, answer, freqMap, rt);
    console.log("");
  }
}

async function runOcrMode(words: string[], freqMap: Map<string, number>, rt: LangRuntime): Promise<void> {
  console.log("Modo OCR iniciado.");
  console.log("Conceda permissão de gravação de tela para o terminal/IDE no macOS.");
  console.log("Controles:");
  console.log("- s: forcar screenshot imediato");
  console.log("- r: abrir overlay para selecionar/redimensionar regiao");
  console.log("- a: voltar para tela inteira");
  console.log("- t: digitar a ultima recomendacao no campo focado (macOS; sem Cmd+V — ver aviso no terminal)");
  console.log("- Ctrl+C: encerrar\n");

  const loadedRegion = loadSavedOcrRegion();
  let activeRegion: OcrRegion | null = loadedRegion;
  if (loadedRegion) {
    const enriched = await withScreenDimensions(loadedRegion);
    if (
      enriched.screenWidth !== loadedRegion.screenWidth ||
      enriched.screenHeight !== loadedRegion.screenHeight
    ) {
      persistOcrRegion(enriched);
    }

    activeRegion = enriched;
    console.log(
      `Regiao OCR restaurada (${path.basename(OCR_REGION_SAVE_PATH)}): ${formatRegion(activeRegion)}`
    );
    console.log("");
  }

  const worker: Worker = await createWorker(rt.ocrLanguages);
  let lastBestSequence = "";
  let forceScreenshot = true;
  let isConfiguringRegion = false;
  let shouldStop = false;
  let manualScreenshotRequested = false;
  let lastRecommendedWord: string | null = null;
  const hotkeyLastAt: Partial<Record<"s" | "a" | "r" | "t", number>> = {};

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const keypressHandler = (_str: string, key: readline.Key) => {
    const isDebouncedHotkey = (hotkey: "s" | "a" | "r" | "t"): boolean => {
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
      persistOcrRegion(null);
      forceScreenshot = true;
      console.log("\nOCR configurado para usar tela inteira.");
      return;
    }

    if (key.name === "t") {
      if (isDebouncedHotkey("t")) {
        return;
      }
      const toPaste = lastRecommendedWord;
      if (!toPaste) {
        console.log("\nAinda não há recomendação para digitar. Espera uma detecção com palavras.");
        return;
      }

      void (async () => {
        try {
          await typeRecommendedWordIntoFocusedApp(toPaste);
          console.log(`Digitado: ${normalize(toPaste)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`\nNão foi possível digitar: ${msg}`);
        }
      })();
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
          persistOcrRegion(activeRegion);
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
      const bestSequence = chooseBestSequence(words, candidates, freqMap, rt.locale);

      if (!bestSequence) {
        lastRecommendedWord = null;
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
      lastRecommendedWord = printResult(words, bestSequence, freqMap, rt, {
        humanTierWordPick: true,
      });
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

function parseCliArgs(argv: string[]): { lang: WordLang; tokens: string[] } {
  const tokens: string[] = [];
  let lang: WordLang = "pt";

  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];
    const lower = raw?.toLowerCase() ?? "";

    if (lower === "--english" || lower === "--en") {
      lang = "en";
      continue;
    }

    if (lower === "--lang" || lower === "-l") {
      const v = (argv[i + 1] ?? "").toLowerCase();
      if (v === "en" || v === "english") {
        lang = "en";
      } else if (v === "pt" || v === "pt-br" || v === "portuguese" || v === "pt_br") {
        lang = "pt";
      }
      if (argv[i + 1] !== undefined) {
        i++;
      }
      continue;
    }

    if (lower.startsWith("--lang=")) {
      const v = lower.slice("--lang=".length);
      if (v === "en" || v === "english") {
        lang = "en";
      } else if (v === "pt" || v === "pt-br" || v === "portuguese") {
        lang = "pt";
      }
      continue;
    }

    if (raw) {
      tokens.push(raw);
    }
  }

  return { lang, tokens };
}

async function main(): Promise<void> {
  try {
    const { lang, tokens } = parseCliArgs(process.argv);
    const rt = getLangRuntime(lang);
    const [words, freqMap] = await Promise.all([getWordList(rt), loadWordFrequencies(rt)]);
    const arg0 = tokens[0]?.trim();

    if (arg0 === "--ocr") {
      console.log(
        lang === "en"
          ? "Language: English — word list (dwyl alpha) + OpenSubtitles EN frequencies.\n"
          : "Idioma: Português — lista pythonprobr + frequências PT (OpenSubtitles).\n"
      );
      await runOcrMode(words, freqMap, rt);
      return;
    }

    if (arg0) {
      printResult(words, arg0, freqMap, rt);
      return;
    }

    console.log(
      lang === "en"
        ? "Language: English — switch with --lang pt\n"
        : "Idioma: Português — altera com --lang en\n"
    );
    await runInteractive(words, freqMap, rt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    console.error(message);
    process.exit(1);
  }
}

void main();

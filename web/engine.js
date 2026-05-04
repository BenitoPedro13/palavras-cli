/**
 * Lógica pura espelhada de index.ts (CLI) para a versão web.
 * Mantém os mesmos limites e constantes para resultados consistentes.
 */

export const WORDS_URL =
  "https://raw.githubusercontent.com/pythonprobr/palavras/master/palavras.txt";
export const FREQUENCY_URL =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/pt/pt_full.txt";

export const MAX_RESULTS = 5;
export const MAX_WORD_LENGTH = 15;
export const ALLOW_HYPHEN_IN_LEXEME = false;
export const ALLOW_APOSTROPHE_IN_LEXEME = true;

const LETTER_POINTS = {
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

export function normalize(value) {
  return value.toUpperCase();
}

export function normalizeLetters(value) {
  return normalize(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isSimpleWordLexeme(word) {
  return /^[\p{L}]+$/u.test(word);
}

function isCompoundLexemeByFlags(word) {
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

function isAllowedLexeme(word) {
  if (!ALLOW_HYPHEN_IN_LEXEME && !ALLOW_APOSTROPHE_IN_LEXEME) {
    return isSimpleWordLexeme(word);
  }
  return isCompoundLexemeByFlags(word);
}

export function getWordPoints(word) {
  let total = 0;
  for (const letter of normalizeLetters(word)) {
    total += LETTER_POINTS[letter] ?? 0;
  }
  return total;
}

export function parseFrequencyCorpus(content) {
  const map = new Map();

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

export function frequencyLookupKey(word) {
  return normalizeLetters(word.toLowerCase());
}

export function getCorpusFrequency(word, freqMap) {
  return freqMap.get(frequencyLookupKey(word)) ?? 0;
}

export function sortMatchesByLengthThenCorpus(matches, freqMap) {
  return [...matches].sort((a, b) => {
    const lenDiff = b.length - a.length;
    if (lenDiff !== 0) {
      return lenDiff;
    }

    const freqDiff = getCorpusFrequency(b, freqMap) - getCorpusFrequency(a, freqMap);
    if (freqDiff !== 0) {
      return freqDiff;
    }

    return a.localeCompare(b, "pt-BR");
  });
}

const LENGTH_TIER_WEIGHTS = {
  short: 0.18,
  medium: 0.32,
  long: 0.5,
};

function lengthTierForWord(len, minLen, maxLen) {
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

function bucketMatchesByLengthTier(matches) {
  const buckets = { short: [], medium: [], long: [] };
  const lengths = matches.map((w) => w.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);

  for (const w of matches) {
    buckets[lengthTierForWord(w.length, minLen, maxLen)].push(w);
  }

  return buckets;
}

function sortMatchesByCorpusThenLocale(matches, freqMap) {
  return [...matches].sort((a, b) => {
    const freqDiff = getCorpusFrequency(b, freqMap) - getCorpusFrequency(a, freqMap);
    if (freqDiff !== 0) {
      return freqDiff;
    }
    return a.localeCompare(b, "pt-BR");
  });
}

function pickRandomFromCorpusWeightedPool(sortedByCorpus, poolMax) {
  const n = sortedByCorpus.length;
  const poolSize = Math.min(poolMax, n);
  const idx = Math.floor(Math.random() * poolSize);
  return sortedByCorpus[idx];
}

function weightedRandomAmongTiers(nonEmptyTiers) {
  let sum = 0;
  const weights = [];

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

export function pickPlayWordHumanTiered(matches, freqMap) {
  if (matches.length === 1) {
    return { word: matches[0], tier: "medium" };
  }

  const buckets = bucketMatchesByLengthTier(matches);
  const tierOrder = ["short", "medium", "long"];
  const nonEmpty = tierOrder.filter((t) => buckets[t].length > 0);

  const tier = nonEmpty.length === 1 ? nonEmpty[0] : weightedRandomAmongTiers(nonEmpty);
  const ranked = sortMatchesByCorpusThenLocale(buckets[tier], freqMap);

  return { word: pickRandomFromCorpusWeightedPool(ranked, 5), tier };
}

export function findMatchingWords(words, sequence) {
  const matches = [];
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

  return matches.sort((a, b) => b.length - a.length || a.localeCompare(b, "pt-BR"));
}

export function highlightSequence(word, sequence) {
  const upperWord = normalize(word);
  const upperSequence = normalize(sequence);
  const start = upperWord.indexOf(upperSequence);

  if (start === -1) {
    return word;
  }

  const end = start + sequence.length;
  return `${word.slice(0, start)}-${upperSequence}-${word.slice(end)}`;
}

export function extractCandidateSequences(text) {
  const normalized = normalizeLetters(text);
  const rawTokens = normalized.match(/[A-Z]{2,5}/g) ?? [];
  const unique = new Set();

  for (const token of rawTokens) {
    unique.add(token);
  }

  return [...unique];
}

export function chooseBestSequence(words, candidates, freqMap) {
  let best = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const matches = findMatchingWords(words, candidate);
    if (matches.length === 0) {
      continue;
    }

    const topWord = sortMatchesByLengthThenCorpus(matches, freqMap)[0];
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

/**
 * @returns {null | {
 *   sequenceUpper: string,
 *   matchCount: number,
 *   criterionNote: string,
 *   pickShown: string,
 *   pickWord: string,
 *   pickFreq: number,
 *   tier?: string,
 *   restForPlay: { word: string, shown: string, len: number, freqLabel: string }[],
 *   highestPoints: { word: string, shown: string, points: number }[]
 * }}
 */
export function buildSearchPresentation(words, freqMap, sequence, options = {}) {
  const matches = findMatchingWords(words, sequence);
  const sequenceUpper = normalize(sequence);

  if (matches.length === 0) {
    return null;
  }

  const sortedForPlay = sortMatchesByLengthThenCorpus(matches, freqMap);

  let pick;
  let criterionNote;
  let tierPt;

  if (options.humanTierWordPick) {
    const { word, tier } = pickPlayWordHumanTiered(matches, freqMap);
    pick = word;
    tierPt =
      tier === "short" ? "faixa curta" : tier === "medium" ? "faixa média" : "faixa longa";
    criterionNote =
      `modo OCR (mais natural): entre os comprimentos possíveis para esta sequência foi sorteada a ${tierPt}; ` +
      `dentro dela, palavra aleatória entre as ~5 mais frequentes no corpus`;
  } else {
    pick = sortedForPlay[0];
    criterionNote =
      "palavra mais longa no dicionário que contém a sequência; empate por uso no corpus — FrequencyWords / legendas PT";
  }

  const pickShown = normalize(pick);
  const pickFreq = getCorpusFrequency(pick, freqMap);

  const restForPlay = sortedForPlay
    .filter((w) => w !== pick)
    .slice(0, MAX_RESULTS)
    .map((word) => {
      const f = getCorpusFrequency(word, freqMap);
      return {
        word,
        shown: normalize(word),
        highlight: highlightSequence(word, sequenceUpper),
        len: word.length,
        freqLabel: f > 0 ? `~${f.toLocaleString("pt-BR")} no corpus` : "fora do corpus",
      };
    });

  const highestPoints = [...matches]
    .sort((a, b) => {
      const scoreDiff = getWordPoints(b) - getWordPoints(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return a.localeCompare(b, "pt-BR");
    })
    .slice(0, MAX_RESULTS)
    .map((word) => ({
      word,
      shown: normalize(word),
      points: getWordPoints(word),
      highlight: highlightSequence(word, sequenceUpper),
    }));

  return {
    sequenceUpper,
    matchCount: matches.length,
    criterionNote,
    pickShown,
    pickWord: pick,
    pickFreq,
    tier: tierPt,
    pickHighlight: highlightSequence(pick, sequenceUpper),
    pickLen: pick.length,
    restForPlay,
    highestPoints,
  };
}

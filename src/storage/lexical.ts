/**
 * Lexical search used by the memory and message search paths.
 *
 * Deterministic and dependency-free so the same scoring runs in tests, in the
 * IndexedDB fallback and (as a re-rank step) over SQLite FTS candidate rows.
 */

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'that',
  'this',
  'these',
  'those',
  'i',
  'you',
  'my',
  'your',
  'me',
  'we',
  'they',
  'he',
  'she',
  'do',
  'does',
  'did',
  'so',
  'at',
  'as',
  'by',
  'from',
  'about',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export interface ScoredDocument {
  id: string;
  text: string;
  /** Multiplier applied after scoring (importance, recency, confidence). */
  weight?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  matchedTerms: string[];
}

/**
 * BM25-lite. k1 = 1.2, b = 0.75 — the usual defaults; document length
 * normalisation keeps long memory summaries from dominating short facts.
 */
export function searchDocuments(
  query: string,
  documents: ScoredDocument[],
  limit = 8,
): SearchHit[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const tokenized = documents.map((document) => tokenize(document.text));
  const averageLength =
    tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, tokenized.length);
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  const total = documents.length;
  const hits: SearchHit[] = [];

  documents.forEach((document, index) => {
    const tokens = tokenized[index] ?? [];
    const length = tokens.length || 1;
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    let score = 0;
    const matchedTerms: string[] = [];
    for (const term of new Set(queryTerms)) {
      const frequency = counts.get(term) ?? 0;
      if (frequency === 0) continue;
      matchedTerms.push(term);
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator = frequency + k1 * (1 - b + (b * length) / averageLength);
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }
    if (score > 0) {
      hits.push({ id: document.id, score: score * (document.weight ?? 1), matchedTerms });
    }
  });

  return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
}

/**
 * Reciprocal rank fusion (PLAN §9.4 step 3) — blends two ranked lists so a
 * future embedding search can be added without retuning weights.
 */
export function reciprocalRankFusion<T extends { id: string }>(
  lists: Array<Array<T & { score: number }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const contribution = 1 / (k + index + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

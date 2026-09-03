import { qdrant } from "../lib/qdrant.js";
import { REPO_CODE_COLLECTION } from "../config/constants.js";
import type { SearchResult } from "./code-search.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "the",
  "to",
  "used",
  "uses",
  "using",
  "what",
  "where",
  "which",
]);

export type LexicalSearchResult = SearchResult & {
  lexicalScore: number;
};

function normalize(text: string): string {
  return text.toLowerCase();
}

function tokenize(text: string): string[] {
  return text
    .split(/[^a-zA-Z0-9_$]+/)
    .map((token) => normalize(token.trim()))
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token));
}

function lexicalScore(query: string, result: SearchResult): number {
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return 0;
  }

  const symbolName = normalize(result.symbolName ?? "");

  const file = normalize(result.file ?? "");

  const content = normalize(result.content ?? "");

  let score = 0;

  for (const token of queryTokens) {
    if (symbolName === token) {
      score += 12;
    } else if (symbolName.includes(token)) {
      score += 6;
    }

    if (file.includes(token)) {
      score += 3;
    }

    if (content.includes(token)) {
      score += 4;
    }
  }

  return score;
}

export async function lexicalSearchCode(
  query: string,
  limit = 20,
): Promise<LexicalSearchResult[]> {
  const response = await qdrant.scroll(REPO_CODE_COLLECTION, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  });

  return response.points
    .map((point): SearchResult => {
      const payload = point.payload ?? {};

      return {
        score: 0,

        repoId: typeof payload.repoId === "string" ? payload.repoId : undefined,

        file: typeof payload.file === "string" ? payload.file : undefined,

        symbolName:
          typeof payload.symbolName === "string"
            ? payload.symbolName
            : undefined,

        symbolType:
          typeof payload.symbolType === "string"
            ? payload.symbolType
            : undefined,

        startLine:
          typeof payload.startLine === "number" ? payload.startLine : undefined,

        endLine:
          typeof payload.endLine === "number" ? payload.endLine : undefined,

        content:
          typeof payload.content === "string" ? payload.content : undefined,
      };
    })
    .map((result) => ({
      ...result,
      lexicalScore: lexicalScore(query, result),
    }))
    .filter((result) => result.lexicalScore > 0)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, limit);
}

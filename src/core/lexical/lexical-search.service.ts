import path from "node:path";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../repository/repository-identity.js";
import type { SearchResult } from "../retrieval/code-search.service.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "does", "how", "in", "is", "it",
  "of", "on", "the", "to", "used", "uses", "using", "what", "where", "which",
]);

export type LexicalSearchResult = SearchResult & {
  documentId: string;
  lexicalScore: number;
  snippet: string;
};

function identifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function queryTokens(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/[^a-zA-Z0-9_$]+/)
        .map((token) => token.replace(/\$/g, ""))
        .filter(Boolean)
        .filter((token) => !STOP_WORDS.has(token.toLowerCase())),
    ),
  );
}

function toMatchQuery(query: string): string {
  return queryTokens(query)
    .map((token) => {
      const normalized = token.toLowerCase();
      const parts = identifierParts(token);

      if (parts.length <= 1) {
        return `${normalized}*`;
      }

      return `${normalized}* OR (${parts.map((part) => `${part}*`).join(" AND ")})`;
    })
    .join(" OR ");
}

export async function searchLexical(
  query: string,
  limit = 20,
  repoPath = process.cwd(),
  filePrefix?: string,
): Promise<LexicalSearchResult[]> {
  const matchQuery = toMatchQuery(query);

  if (!matchQuery || limit <= 0) {
    return [];
  }

  const absoluteRepoPath = path.resolve(repoPath);
  const store = new AtlasStore(
    path.join(absoluteRepoPath, ".codeatlas", "atlas.db"),
  );
  const repoId = store.ensureRepository(
    getRepositoryIdentity(absoluteRepoPath),
  ).id;

  try {
    return store.searchLexical(repoId, matchQuery, limit, filePrefix).map((row) => ({
      score: row.score,
      repoId,
      file: row.file,
      symbolName: row.symbolName,
      symbolType: row.symbolType,
      startLine: row.startLine,
      endLine: row.endLine,
      content: row.content,
      documentId: row.documentId,
      lexicalScore: Math.max(0, -row.score),
      snippet: row.snippet,
    }));
  } finally {
    store.close();
  }
}

export const lexicalSearchCode = searchLexical;

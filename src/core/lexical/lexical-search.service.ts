import path from "node:path";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { LexicalSearchRow } from "../../storage/atlas/atlas.types.js";
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
  lexicalRankGroup?: string;
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

function ownerContextNames(query: string): string[] {
  const tokens = queryTokens(query).map((token) => token.toLowerCase());
  const names = new Set(tokens);
  for (let start = 0; start < tokens.length; start += 1) {
    let combined = tokens[start] ?? "";
    for (let end = start + 1; end < tokens.length; end += 1) {
      combined += tokens[end];
      names.add(combined);
    }
  }
  return [...names];
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

function bareIdentifier(query: string): string | undefined {
  const trimmed = query.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) return undefined;
  const normalized = trimmed.replace(/\$/g, "").toLowerCase();
  return normalized || undefined;
}

function ownerContextRankGroups(query: string, rows: LexicalSearchRow[]): Map<string, string> {
  const queryParts = Array.from(new Set(queryTokens(query).flatMap(identifierParts)));
  const candidates = new Map<string, LexicalSearchRow[]>();

  for (const row of rows) {
    if (row.symbolType !== "method" || !row.qualifiedName || !row.symbolName) continue;
    const symbolParts = new Set(identifierParts(row.symbolName));
    const qualifiedParts = new Set(identifierParts(row.qualifiedName));
    if (qualifiedParts.size <= symbolParts.size) continue;

    const ownerEvidence = queryParts.filter((part) => !symbolParts.has(part) && qualifiedParts.has(part)).sort();
    if (ownerEvidence.length === 0) continue;

    // Group only same-name methods with matching owner-query evidence and score; never infer global ties from scores alone.
    const key = JSON.stringify([row.symbolType, row.symbolName.toLowerCase(), ownerEvidence, row.score]);
    const group = candidates.get(key) ?? [];
    group.push(row);
    candidates.set(key, group);
  }

  const groups = new Map<string, string>();
  for (const [key, group] of candidates) {
    if (group.length < 2) continue;
    const rankGroup = `owner-context:${key}`;
    for (const row of group) groups.set(row.documentId, rankGroup);
  }
  return groups;
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
    const rows = store.searchLexical(repoId, matchQuery, limit, filePrefix, bareIdentifier(query), ownerContextNames(query));
    const ownerGroups = ownerContextRankGroups(query, rows);
    return rows.map((row) => ({
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
      ...((row.lexicalRankGroup ?? ownerGroups.get(row.documentId))
        ? { lexicalRankGroup: row.lexicalRankGroup ?? ownerGroups.get(row.documentId) }
        : {}),
    }));
  } finally {
    store.close();
  }
}

export const lexicalSearchCode = searchLexical;

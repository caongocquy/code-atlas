import type { SearchResult } from "./code-search.service.js";
import { searchableIdentifier } from "../lexical/searchable-identifier.js";

type NameEncoding = "raw" | "lexical";

// Only reverse an exact, uniquely round-trippable lexical encoding.
// Do not split on the first space: some languages have multiword identifiers.
function originalLexicalName(name: string): string {
  const candidates: string[] = [];
  for (let index = name.indexOf(" "); index !== -1; index = name.indexOf(" ", index + 1)) {
    const prefix = name.slice(0, index);
    if (prefix && searchableIdentifier(prefix) === name) candidates.push(prefix);
  }
  return candidates.length === 1 ? candidates[0]! : name;
}

/** Internal candidate identity; public search result names and keys remain unchanged. */
export function retrievalCandidateKey(
  result: SearchResult,
  encoding: NameEncoding = "raw",
  repositoryId = result.repoId,
): string {
  // Preserve legacy matching when a complete source occurrence is unavailable.
  if (!repositoryId || !result.file || !result.symbolType || !result.symbolName ||
    result.startLine === undefined || result.endLine === undefined) {
    return [repositoryId ?? "", result.file ?? "", result.symbolType ?? "", result.symbolName ?? "", result.startLine ?? ""].join(":");
  }
  const name = encoding === "lexical" ? originalLexicalName(result.symbolName) : result.symbolName;
  return JSON.stringify([repositoryId, result.file, result.symbolType, name, result.startLine, result.endLine]);
}

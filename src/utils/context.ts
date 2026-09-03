import type { SearchResult } from "../services/code-search.js";

export function buildContext(chunks: SearchResult[]): string {
  return chunks
    .map((chunk, index) =>
      [
        `## Context ${index + 1}`,
        `File: ${chunk.file ?? "unknown"}`,
        `Symbol: ${chunk.symbolName ?? "unknown"}`,
        `Type: ${chunk.symbolType ?? "unknown"}`,
        `Lines: ${chunk.startLine ?? "?"}-${chunk.endLine ?? "?"}`,
        `Score: ${chunk.score.toFixed(4)}`,
        "",
        chunk.content ?? "",
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

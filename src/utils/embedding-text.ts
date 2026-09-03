import type { CodeChunk } from "../parsers/types.js";

export function buildEmbeddingText(filePath: string, chunk: CodeChunk): string {
  return [
    `File: ${filePath}`,
    `Language: ${chunk.language}`,
    `Type: ${chunk.symbolType}`,
    `Symbol: ${chunk.symbolName}`,
    "",
    chunk.content,
  ].join("\n");
}

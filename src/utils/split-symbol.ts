import type { CodeChunk } from "../parsers/types.js";

const MAX_LINES = 120;
const OVERLAP_LINES = 20;

export function splitLargeSymbol(chunk: CodeChunk): CodeChunk[] {
  const lines = chunk.content.split("\n");

  if (lines.length <= MAX_LINES) {
    return [chunk];
  }

  const step = MAX_LINES - OVERLAP_LINES;
  const parts: CodeChunk[] = [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + MAX_LINES, lines.length);

    parts.push({
      ...chunk,
      content: lines.slice(start, end).join("\n"),
      startLine: chunk.startLine + start,
      endLine: chunk.startLine + end - 1,
    });

    if (end === lines.length) {
      break;
    }
  }

  return parts.map((part, index) => ({
    ...part,
    part: index + 1,
    totalParts: parts.length,
  }));
}

import { createHash } from "node:crypto";

import type { FactBlobKey, ParsedFactsBlob } from "./facts.types.js";

export function factBlobKey(
  input: Pick<
    ParsedFactsBlob,
    | "contentHash"
    | "language"
    | "parserIdentity"
    | "factsVersion"
    | "factsSchemaVersion"
  >,
): FactBlobKey {
  return createHash("sha256")
    .update(canonicalJson({
      contentHash: input.contentHash,
      language: input.language,
      parserIdentity: input.parserIdentity,
      factsVersion: input.factsVersion,
      factsSchemaVersion: input.factsSchemaVersion,
    }))
    .digest("hex") as FactBlobKey;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

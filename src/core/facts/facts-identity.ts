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
    .update(JSON.stringify({
      contentHash: input.contentHash,
      language: input.language,
      parserIdentity: {
        language: input.parserIdentity.language,
        parserName: input.parserIdentity.parserName,
        parserVersion: input.parserIdentity.parserVersion,
        grammarName: input.parserIdentity.grammarName,
        grammarVersion: input.parserIdentity.grammarVersion,
        adapterVersion: input.parserIdentity.adapterVersion,
      },
      factsVersion: input.factsVersion,
      factsSchemaVersion: input.factsSchemaVersion,
    }))
    .digest("hex") as FactBlobKey;
}

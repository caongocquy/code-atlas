import type { MaterializedFileFacts, ParsedFactsBlob } from "./facts.types.js";
import type { LanguageId } from "../graph/parsers/types.js";
import {
  getLanguageFactExtractor,
  type LanguageFactExtractorInput,
} from "./language-fact-extractor.js";

export type FactExtractionInput = Omit<LanguageFactExtractorInput, "filePath"> & {
  filePath?: string;
};

export type FactExtractionOutcome =
  | { kind: "facts"; facts: ParsedFactsBlob }
  | { kind: "infrastructure_failure"; error: Error };

/** Compatibility entry point; the singular language registry owns dispatch. */
export function extractFactsForLanguage(input: LanguageFactExtractorInput): FactExtractionOutcome {
  const extractor = getLanguageFactExtractor(input.language);
  return extractor === undefined
    ? { kind: "infrastructure_failure", error: new Error("Parser or extractor unavailable") }
    : extractor.extract(input);
}

export function materializeFileFacts(relativePath: string, facts: ParsedFactsBlob): MaterializedFileFacts {
  return { relativePath, facts };
}

export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome {
  const language = input.language as LanguageId;
  const filePath = input.filePath ?? `source.${language === "typescript"
    ? "ts"
    : language === "tsx"
      ? "tsx"
      : language === "javascript"
        ? "js"
        : "unknown"}`;
  return extractFactsForLanguage({ ...input, filePath, language });
}

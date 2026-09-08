import type { LanguageId } from "../graph/parsers/types.js";
import type { FactExtractionOutcome } from "./facts-extractor.js";

export type LanguageFactExtractorInput = {
  source: string;
  filePath: string;
  language: LanguageId;
  contentHash: string;
  factsVersion: string;
  factsSchemaVersion: string;
};

export type LanguageFactExtractor = {
  readonly language: LanguageId;
  extract(input: LanguageFactExtractorInput): FactExtractionOutcome;
};

const extractors = new Map<LanguageId, LanguageFactExtractor>();

export function registerLanguageFactExtractor(extractor: LanguageFactExtractor): void {
  extractors.set(extractor.language, extractor);
}

export function getLanguageFactExtractor(language: LanguageId): LanguageFactExtractor | undefined {
  return extractors.get(language);
}

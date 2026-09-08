import type { LanguageId } from "../graph/parsers/types.js";
import type { FactExtractionOutcome } from "./facts-extractor.js";
import { cFactExtractor } from "./extractors/c.js";
import { cppFactExtractor } from "./extractors/cpp.js";
import { dartFactExtractor } from "./extractors/dart.js";
import {
  javascriptFactExtractor,
  tsxFactExtractor,
  typescriptFactExtractor,
} from "./extractors/ecmascript.js";
import { goFactExtractor } from "./extractors/go.js";
import { javaFactExtractor } from "./extractors/java.js";
import { kotlinFactExtractor } from "./extractors/kotlin.js";
import { pythonFactExtractor } from "./extractors/python.js";
import { rustFactExtractor } from "./extractors/rust.js";
import { swiftFactExtractor } from "./extractors/swift.js";

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
  if (extractors.has(extractor.language)) {
    throw new Error(`Language fact extractor already registered for ${extractor.language}`);
  }
  extractors.set(extractor.language, extractor);
}

export function getLanguageFactExtractor(language: LanguageId): LanguageFactExtractor | undefined {
  return extractors.get(language);
}

for (const extractor of [
  javascriptFactExtractor,
  typescriptFactExtractor,
  tsxFactExtractor,
  pythonFactExtractor,
  javaFactExtractor,
  kotlinFactExtractor,
  goFactExtractor,
  rustFactExtractor,
  swiftFactExtractor,
  dartFactExtractor,
  cFactExtractor,
  cppFactExtractor,
] as const) {
  registerLanguageFactExtractor(extractor);
}

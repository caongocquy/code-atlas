import { parseSource } from "../../graph/parsers/code-parser.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";
import { extractCFamilyTreeFacts } from "./c.js";

export function extractCppFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "cpp") return { kind: "infrastructure_failure", error: new Error(`Extractor cpp received ${input.language} input`) };
  return extractCFamilyTreeFacts(parseSource(input.source, input.filePath, "cpp"), input);
}

export const cppFactExtractor: LanguageFactExtractor = { language: "cpp", extract: extractCppFacts };

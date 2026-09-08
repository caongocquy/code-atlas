import { getLanguageAdapter } from "../parsers/registry.js";
import { LANGUAGE_IDS, type LanguageAdapter } from "../parsers/types.js";
import { cFamilySemanticAdapter } from "./adapters/c-family.js";
import { dartSemanticAdapter } from "./adapters/dart.js";
import { ecmascriptSemanticAdapter } from "./adapters/ecmascript.js";
import { goSemanticAdapter } from "./adapters/go.js";
import { jvmSemanticAdapter } from "./adapters/jvm.js";
import { pythonSemanticAdapter } from "./adapters/python.js";
import { rustSemanticAdapter } from "./adapters/rust.js";
import { swiftSemanticAdapter } from "./adapters/swift.js";
import type { LanguageId, LanguageSemanticAdapter } from "./types.js";

export { getLanguageAdapter };
export type { LanguageAdapter };

export const semanticAdapters = [
  ecmascriptSemanticAdapter,
  pythonSemanticAdapter,
  jvmSemanticAdapter,
  goSemanticAdapter,
  rustSemanticAdapter,
  swiftSemanticAdapter,
  dartSemanticAdapter,
  cFamilySemanticAdapter,
] as const satisfies readonly LanguageSemanticAdapter[];

export type LanguageFloorState = "green" | "unverified";
export type LanguageFloorStatus = Readonly<Record<LanguageId, LanguageFloorState>>;

/** Release-owned evidence gate; runtime test modules must not be imported by production code. */
export const LANGUAGE_FLOOR_STATUS: LanguageFloorStatus = Object.freeze({
  typescript: "green",
  tsx: "green",
  javascript: "green",
  python: "green",
  java: "green",
  kotlin: "green",
  go: "green",
  rust: "green",
  swift: "green",
  dart: "green",
  c: "green",
  cpp: "green",
});

function createSemanticAdapterIndex(): ReadonlyMap<LanguageId, LanguageSemanticAdapter> {
  const index = new Map<LanguageId, LanguageSemanticAdapter>();
  for (const adapter of semanticAdapters) {
    for (const language of adapter.languages) {
      if (index.has(language)) {
        throw new Error(`Semantic adapter already registered for ${language}`);
      }
      index.set(language, adapter);
    }
  }
  return index;
}

const semanticAdapterByLanguage = createSemanticAdapterIndex();

export function getSemanticAdapter(language: LanguageId): LanguageSemanticAdapter | undefined {
  return semanticAdapterByLanguage.get(language);
}

export function isLanguageAdvertised(
  language: LanguageId,
  floorStatus: LanguageFloorStatus = LANGUAGE_FLOOR_STATUS,
): boolean {
  return floorStatus[language] === "green" && semanticAdapterByLanguage.has(language);
}

export function getSupportedLanguages(
  floorStatus: LanguageFloorStatus = LANGUAGE_FLOOR_STATUS,
): readonly LanguageId[] {
  return LANGUAGE_IDS.filter((language) => isLanguageAdvertised(language, floorStatus));
}

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

const semanticAdapterByLanguage = new Map<LanguageId, LanguageSemanticAdapter>(
  semanticAdapters.flatMap((adapter) => adapter.languages.map((language) => [language, adapter] as const)),
);

export function getSemanticAdapter(language: LanguageId): LanguageSemanticAdapter | undefined {
  return semanticAdapterByLanguage.get(language);
}

export function getSupportedLanguages(): readonly LanguageId[] {
  return LANGUAGE_IDS.filter((language) => semanticAdapterByLanguage.has(language));
}

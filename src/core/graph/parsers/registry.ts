import path from "node:path";

import { tsxAdapter, typescriptAdapter } from "./adapters/typescript.js";
import { javascriptAdapter } from "./adapters/javascript.js";
import { LANGUAGE_CONFIGS } from "./languages.js";
import type { LanguageAdapter } from "./types.js";

const ecmascriptAdapters: LanguageAdapter[] = [
  typescriptAdapter,
  tsxAdapter,
  javascriptAdapter,
];

const adapters: readonly LanguageAdapter[] = LANGUAGE_CONFIGS.map((config) =>
  ecmascriptAdapters.find((adapter) => adapter.language === config.language) ?? {
    language: config.language,
    extensions: [...config.extensions],
    grammar: config.grammar,
    metadata: config.metadata,
    extractSymbols: () => [],
  },
);

export function getLanguageAdapter(filePath: string): LanguageAdapter | null {
  const extension = path.extname(filePath).toLowerCase();

  return (
    adapters.find((adapter) => adapter.extensions.includes(extension)) ?? null
  );
}

import path from "node:path";

import { tsxAdapter, typescriptAdapter } from "./adapters/typescript.js";
import { javascriptAdapter } from "./adapters/javascript.js";
import type { LanguageAdapter } from "./types.js";

const adapters: LanguageAdapter[] = [
  typescriptAdapter,
  tsxAdapter,
  javascriptAdapter,
];

export function getLanguageAdapter(filePath: string): LanguageAdapter | null {
  const extension = path.extname(filePath).toLowerCase();

  return (
    adapters.find((adapter) => adapter.extensions.includes(extension)) ?? null
  );
}

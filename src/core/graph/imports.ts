import path from "node:path";

import type { ImportFact } from "../facts/facts.types.js";
import type { SupportedLanguage } from "./parsers/types.js";

export type ImportReference = {
  source: string;
};

export function extractImports(source: string): ImportReference[] {
  const results: ImportReference[] = [];
  const seen = new Set<string>();

  const importRegex = /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

  const exportRegex = /export\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g;

  for (const regex of [importRegex, exportRegex]) {
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
      const importSource = match[1];

      if (!importSource) {
        continue;
      }

      if (seen.has(importSource)) {
        continue;
      }

      seen.add(importSource);

      results.push({
        source: importSource,
      });
    }
  }

  return results;
}

export function isRelativeImport(importSource: string): boolean {
  const normalizedSource = importSource.replaceAll("\\", "/");
  return normalizedSource.startsWith("./") || normalizedSource.startsWith("../");
}

function normalizeGraphPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

export function resolveImportCandidates(
  importerFile: string,
  importSource: string,
): string[] {
  const importerDir = path.posix.dirname(normalizeGraphPath(importerFile));

  const resolvedBase = normalizeGraphPath(path.posix.join(importerDir, importSource));

  const extension = path.posix.extname(resolvedBase);

  if (extension === ".js") {
    const withoutExtension = resolvedBase.slice(0, -extension.length);

    return [
      `${withoutExtension}.ts`,
      `${withoutExtension}.tsx`,
      `${withoutExtension}.js`,
      `${withoutExtension}.jsx`,
    ];
  }

  if ([".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".json", ".css"].includes(extension)) {
    return [resolvedBase];
  }

  return [
    ...(extension ? [resolvedBase] : []),
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.js`,
    `${resolvedBase}.jsx`,
    path.posix.join(resolvedBase, "index.ts"),
    path.posix.join(resolvedBase, "index.tsx"),
    path.posix.join(resolvedBase, "index.js"),
    path.posix.join(resolvedBase, "index.jsx"),
  ];
}

export function resolveLanguageImportCandidates(
  importerFile: string,
  importSource: string,
  language: SupportedLanguage,
): string[] {
  if (language === "python" && importSource.startsWith(".")) {
    const relative = importSource.replace(/^\.+/, "") || path.basename(importerFile, path.extname(importerFile));
    const base = normalizeGraphPath(path.posix.join(path.posix.dirname(normalizeGraphPath(importerFile)), relative));
    return [`${base}.py`, path.posix.join(base, "__init__.py")];
  }

  if (language === "kotlin") {
    const name = importSource.split(".").filter(Boolean).at(-2) ?? importSource.split(".").at(-1);
    return name ? [path.posix.join(path.posix.dirname(normalizeGraphPath(importerFile)), `${name.toLowerCase()}.kt`)] : [];
  }

  if (language === "rust") {
    const name = importSource.split("::").filter(Boolean).at(-2) ?? importSource.split("::").at(-1);
    return name ? [path.posix.join(path.posix.dirname(normalizeGraphPath(importerFile)), `${name}.rs`), path.posix.join(path.posix.dirname(normalizeGraphPath(importerFile)), name, "mod.rs")] : [];
  }

  return resolveImportCandidates(importerFile, importSource);
}

export function importFactTargets(
  importerPath: string,
  fact: ImportFact,
): readonly string[] {
  if (!isRelativeImport(fact.moduleSpecifier)) {
    return [`module:${fact.moduleSpecifier}`];
  }

  const candidates = resolveImportCandidates(importerPath, fact.moduleSpecifier);
  const normalizedSpecifier = normalizeGraphPath(path.posix.join(path.posix.dirname(normalizeGraphPath(importerPath)), fact.moduleSpecifier));

  if (candidates.includes(normalizedSpecifier)) {
    return [normalizedSpecifier];
  }

  return candidates.map((candidate) => `unresolved:${candidate}`);
}

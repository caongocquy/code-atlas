import { isRelativeImport, resolveImportCandidates } from "./imports.js";

export type ImportBinding = {
  localName: string;
  importedName: string;
  source: string;
  targetFile?: string;
};

function resolveTargetFile(
  importerFile: string,
  importSource: string,
  fileSet: Set<string>,
): string | undefined {
  if (!isRelativeImport(importSource)) {
    return undefined;
  }

  const candidates = resolveImportCandidates(importerFile, importSource);

  return candidates.find((candidate) => fileSet.has(candidate));
}

export function extractImportBindings(
  source: string,
  importerFile: string,
  fileSet: Set<string>,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  //
  // Named imports:
  //
  // import {
  //   foo,
  //   bar as baz,
  // } from "./x.js";
  //

  const namedImportRegex = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;

  let namedMatch: RegExpExecArray | null;

  while ((namedMatch = namedImportRegex.exec(source)) !== null) {
    const importList = namedMatch[1];

    const importSource = namedMatch[2];

    if (!importList || !importSource) {
      continue;
    }

    const targetFile = resolveTargetFile(importerFile, importSource, fileSet);

    const items = importList
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    for (const item of items) {
      const aliasMatch = item.match(
        /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
      );

      if (!aliasMatch) {
        continue;
      }

      const importedName = aliasMatch[1];

      const localName = aliasMatch[2] ?? importedName;

      if (!importedName || !localName) {
        continue;
      }

      bindings.push({
        localName,
        importedName,
        source: importSource,
        targetFile,
      });
    }
  }

  //
  // Default imports:
  //
  // import foo from "./foo.js";
  //

  const defaultImportRegex =
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;

  let defaultMatch: RegExpExecArray | null;

  while ((defaultMatch = defaultImportRegex.exec(source)) !== null) {
    const localName = defaultMatch[1];

    const importSource = defaultMatch[2];

    if (!localName || !importSource) {
      continue;
    }

    const targetFile = resolveTargetFile(importerFile, importSource, fileSet);

    bindings.push({
      localName,
      importedName: "default",
      source: importSource,
      targetFile,
    });
  }

  //
  // Namespace imports:
  //
  // import * as path from "node:path";
  //

  const namespaceImportRegex =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;

  let namespaceMatch: RegExpExecArray | null;

  while ((namespaceMatch = namespaceImportRegex.exec(source)) !== null) {
    const localName = namespaceMatch[1];

    const importSource = namespaceMatch[2];

    if (!localName || !importSource) {
      continue;
    }

    const targetFile = resolveTargetFile(importerFile, importSource, fileSet);

    bindings.push({
      localName,
      importedName: "*",
      source: importSource,
      targetFile,
    });
  }

  return bindings;
}

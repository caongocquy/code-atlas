import path from "node:path";

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
  return importSource.startsWith("./") || importSource.startsWith("../");
}

export function resolveImportCandidates(
  importerFile: string,
  importSource: string,
): string[] {
  const importerDir = path.dirname(importerFile);

  const resolvedBase = path.normalize(path.join(importerDir, importSource));

  const extension = path.extname(resolvedBase);

  if (extension === ".js") {
    const withoutExtension = resolvedBase.slice(0, -extension.length);

    return [
      `${withoutExtension}.ts`,
      `${withoutExtension}.tsx`,
      `${withoutExtension}.js`,
      `${withoutExtension}.jsx`,
    ];
  }

  if (extension) {
    return [resolvedBase];
  }

  return [
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.js`,
    `${resolvedBase}.jsx`,
    path.join(resolvedBase, "index.ts"),
    path.join(resolvedBase, "index.tsx"),
    path.join(resolvedBase, "index.js"),
    path.join(resolvedBase, "index.jsx"),
  ];
}

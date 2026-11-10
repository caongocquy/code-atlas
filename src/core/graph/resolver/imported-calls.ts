import type { FactLocalId } from "../../facts/facts.types.js";
import type { IndexedSourceUnit } from "../../indexing/indexing.types.js";
import { resolveImportCandidates } from "../imports.js";
import { symbolIdentity, symbolIdentityKey, type SymbolIdentity } from "./identities.js";

// Only source-backed relative imports are eligible. External packages and unresolved paths stay unknown.
export function buildImportedCallTargets(
  units: readonly IndexedSourceUnit[],
  repositoryId: string,
): ReadonlyMap<string, readonly SymbolIdentity[]> {
  const files = new Map(units.map((unit) => [unit.relativePath.replaceAll("\\", "/"), unit]));
  const result = new Map<string, readonly SymbolIdentity[]>();
  const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

  function targetFile(importer: string, specifier: string): string | undefined {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    const candidates = [...new Set(resolveImportCandidates(importer, specifier))]
      .filter((candidate) => files.has(candidate));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function exported(file: string, name: string, visited: ReadonlySet<string>, depth: number): readonly SymbolIdentity[] {
    if (depth > 12) return [];
    const key = JSON.stringify([file, name]);
    if (visited.has(key)) return [];
    const next = new Set([...visited, key]);
    const unit = files.get(file);
    if (!unit || !["javascript", "typescript", "tsx"].includes(unit.facts.language)) return [];
    const declarations = unit.facts.exports.filter((item) => item.exportedName === name);
    const matches: SymbolIdentity[] = [];
    const resolveLocal = (localName: string) => {
      const roots = new Map(unit.facts.containmentScopes.map((scope) => [scope.localId, scope]));
      const symbols = unit.facts.symbols.filter((symbol) =>
        symbol.kind === "function" && symbol.name === localName
        && symbol.scopeId && roots.get(symbol.scopeId)?.parentId === "scope:1");
      if (symbols.length === 1) {
        const symbol = symbols[0]!;
        matches.push(symbolIdentity({
          repositoryId, relativePath: file, language: unit.facts.language, kind: symbol.kind,
          qualifiedName: symbol.declaredQualifiedName ?? symbol.name, discriminator: symbol.localId,
        }));
      } else if (symbols.length === 0) {
        const forwarded = unit.facts.imports.filter((item) => item.localName === localName
          && item.kind === "named" && item.importedName);
        if (forwarded.length === 1) {
          const imported = forwarded[0]!;
          const resolved = targetFile(file, imported.moduleSpecifier);
          if (resolved) matches.push(...exported(resolved, imported.importedName!, next, depth + 1));
        }
      }
    };
    if (declarations.length > 0) {
      for (const declaration of declarations) {
        if (declaration.moduleSpecifier) {
          const resolved = targetFile(file, declaration.moduleSpecifier);
          if (resolved && declaration.localName) matches.push(...exported(resolved, declaration.localName, next, depth + 1));
        } else if (declaration.localName) {
          resolveLocal(declaration.localName);
        }
      }
    } else {
      const stars = unit.facts.exports.filter((item) => item.kind === "star" && item.moduleSpecifier);
      for (const star of stars) {
        const resolved = targetFile(file, star.moduleSpecifier!);
        if (resolved) matches.push(...exported(resolved, name, next, depth + 1));
      }
    }
    return [...new Map(matches.map((target) => [symbolIdentityKey(target), target])).values()]
      .sort((a, b) => symbolIdentityKey(a).localeCompare(symbolIdentityKey(b)));
  }

  for (const unit of units) {
    if (!["javascript", "typescript", "tsx"].includes(unit.facts.language)) continue;
    const file = unit.relativePath.replaceAll("\\", "/");
    const scopes = new Map(unit.facts.containmentScopes.map((scope) => [scope.localId, scope]));
    for (const call of unit.facts.callSites) {
      if (!call.scopeId || !identifier.test(call.calleeText)) continue;
      let current: FactLocalId | undefined = call.scopeId;
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        const bindings = unit.facts.bindingSeeds.filter((binding) =>
          binding.name === call.calleeText && binding.ownerId === current);
        const declarations = unit.facts.symbols.filter((symbol) =>
          symbol.kind === "function" && symbol.name === call.calleeText
          && symbol.scopeId && scopes.get(symbol.scopeId)?.parentId === current);
        if (declarations.length > 0 || bindings.length > 0) {
          if (declarations.length === 0 && bindings.length === 1 && bindings[0]!.bindingKind === "import") {
            const imports = unit.facts.imports.filter((item) => item.kind === "named"
              && item.localName === call.calleeText && item.importedName);
            if (imports.length === 1) {
              const importer = imports[0]!;
              const target = targetFile(file, importer.moduleSpecifier);
              if (target) {
                const candidates = exported(target, importer.importedName!, new Set(), 0);
                if (candidates.length > 0) result.set(JSON.stringify([file, call.localId]), candidates);
              }
            }
          }
          break;
        }
        current = scopes.get(current)?.parentId;
      }
    }
  }
  return result;
}

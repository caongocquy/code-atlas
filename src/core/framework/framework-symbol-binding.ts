import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { GraphNode } from "../graph/types.js";
import type { FrameworkAnalysisContext } from "./framework.types.js";

export function frameworkGraphSymbol(
  ctx: FrameworkAnalysisContext,
  relativePath: string,
  facts: ParsedFactsBlob,
  localId: string | undefined,
  kind: "class" | "method",
): GraphNode | undefined {
  if (!localId) return undefined;
  const direct = ctx.graph.nodes.find((node) => node.file === relativePath && node.type === kind && node.id === localId);
  if (direct) return direct;
  const fact = facts.symbols.find((item) => item.localId === localId && item.kind === kind);
  if (!fact) return undefined;
  const qualifiedName = fact.declaredQualifiedName ?? fact.name;
  if (facts.symbols.filter((item) => item.kind === kind && (item.declaredQualifiedName ?? item.name) === qualifiedName).length !== 1) return undefined;
  const nodes = ctx.graph.nodes.filter((node) => node.file === relativePath && node.type === kind && node.qualifiedName === qualifiedName);
  return nodes.length === 1 ? nodes[0] : undefined;
}

export function frameworkEnclosingClass(
  ctx: FrameworkAnalysisContext,
  relativePath: string,
  facts: ParsedFactsBlob,
  methodLocalId: string | undefined,
  methodNode: GraphNode | undefined,
): GraphNode | undefined {
  if (!methodLocalId) return undefined;
  const direct = methodNode && ctx.graph.nodes.find((node) => node.file === relativePath && node.type === "class"
    && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === methodNode.id));
  if (direct) return direct;
  const method = facts.symbols.find((item) => item.localId === methodLocalId && item.kind === "method");
  const scopes = new Map(facts.containmentScopes.map((scope) => [scope.localId, scope]));
  let scopeId = method?.scopeId;
  while (scopeId) {
    const owner = facts.symbols.find((item) => item.kind === "class" && item.scopeId === scopeId);
    if (owner) return frameworkGraphSymbol(ctx, relativePath, facts, owner.localId, "class");
    scopeId = scopes.get(scopeId)?.parentId;
  }
  return undefined;
}

// Competing declarations/imports cannot prove decorator provenance. Fail closed.
export function frameworkImportedName(facts: ParsedFactsBlob, name: string | undefined, moduleSpecifier: string): string | undefined {
  if (!name) return undefined;
  const imports = facts.imports.filter((item) => item.localName === name);
  if (imports.length !== 1 || imports[0]!.kind !== "named" || imports[0]!.moduleSpecifier !== moduleSpecifier) return undefined;
  if (facts.symbols.some((item) => item.name === name && item.kind !== "method")
    || facts.bindingSeeds.some((item) => item.name === name && item.bindingKind !== "import")) return undefined;
  // Annotation-type declarations have no symbol in current JVM facts.
  const contains = (outer: { startLine: number; endLine: number; startColumn?: number; endColumn?: number }, inner: typeof outer) =>
    (inner.startLine > outer.startLine || (inner.startLine === outer.startLine && (inner.startColumn ?? 0) >= (outer.startColumn ?? 0)))
    && (inner.endLine < outer.endLine || (inner.endLine === outer.endLine && (inner.endColumn ?? 0) <= (outer.endColumn ?? 0)));
  if (facts.frameworkSyntax?.nodes.some((item) => item.kind === "annotation" && item.name === name && !item.ownerSymbolId)) return undefined;
  if (facts.frameworkSyntax?.nodes.some((item) => item.kind === "identifier" && item.name === name && !item.ownerSymbolId
    && !facts.imports.some((entry) => contains(entry.range, item.range))
    && !facts.frameworkSyntax!.nodes.some((entry) => entry.kind === "annotation" && contains(entry.range, item.range)))) return undefined;
  return imports[0]!.importedName;
}

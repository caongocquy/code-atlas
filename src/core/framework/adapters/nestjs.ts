import path from "node:path";
import type { ParsedFactsBlob } from "../../facts/facts.types.js";
import type { SyntaxObservation } from "../../facts/objective-syntax.types.js";
import { frameworkEntityKey } from "../framework-identity.js";
import { frameworkEnclosingClass, frameworkGraphSymbol, frameworkImportedName } from "../framework-symbol-binding.js";
import type { DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSubjectRef } from "../framework.types.js";

export function canonicalizeNestRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "nestjs") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Nest route" };
  const scope = input.scope;
  const router = input.router;
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || input.path.includes("\\") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "nestjs" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

const literal = (node: { kind: string; value?: string | number | boolean | null; name?: string } | undefined): string | undefined =>
  node?.kind === "literal" && typeof node.value === "string" ? node.value : undefined;

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const configured = ctx.config.some((item) => item.kind === "package" && Object.hasOwn(item.values, "@nestjs/common"));
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "@nestjs/common" || value.moduleSpecifier.startsWith("@nestjs/")));
  if (!configured && !observed) return [];
  const graphql = ctx.config.some((item) => item.kind === "package" && Object.hasOwn(item.values, "@nestjs/graphql"))
    || ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "@nestjs/graphql"));
  const annotations = ctx.facts.flatMap((item) => item.facts.frameworkSyntax?.nodes.filter((node) => node.kind === "annotation").map((node) => node.name) ?? []);
  const capabilities = [
    ...(["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"].some((name) => annotations.includes(name)) ? ["nestjs.routes"] : []),
    ...(annotations.includes("Module") ? ["nestjs.modules"] : []),
    ...(ctx.facts.some((item) => item.facts.parameters?.some((parameter) => !!parameter.typeText)) ? ["nestjs.injection"] : []),
    ...(graphql ? ["nestjs.graphql"] : []),
  ];
  const refs = ctx.config.filter((item) => item.kind === "package").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "nestjs", scope: "root", configured, observed, capabilities, refs, complete: ctx.config.every((item) => item.complete) }];
}

function graphqlName(annotation: SyntaxObservation, nodes: Map<string, SyntaxObservation>, fallback: string, nested = false): string | undefined {
  const args = annotation.arguments.map((arg) => nodes.get(arg.valueId));
  if (args.some((arg) => !arg) || args.length > (nested ? 3 : 2)) return undefined;
  if (args.length === 0) return fallback;
  const first = args[0]!;
  let name = fallback;
  let options: SyntaxObservation | undefined;
  if (first.kind === "literal") {
    const declared = literal(first);
    if (declared === undefined) return undefined;
    name = declared;
    if (!nested && args.length !== 1) return undefined;
    if (nested) {
      if (args[1]?.kind === "lambda") options = args[2];
      else if (args.length <= 2) options = args[1];
      else return undefined;
    }
  } else if (first.kind === "lambda") {
    if (args.length > 2) return undefined;
    options = args[1];
  } else if (nested && first.kind === "object" && args.length === 1) options = first;
  else return undefined;
  if (!options) return name;
  if (options.kind !== "object") return undefined;
  const properties = options.children.map((id) => nodes.get(id));
  if (properties.some((node) => !node || node.kind !== "property" || node.children.length !== 1)) return undefined;
  const names = properties.filter((node) => node?.name === "name");
  if (names.length > 1) return undefined;
  return names.length === 0 ? name : literal(nodes.get(names[0]!.children[0]!));
}

function resolverParent(ctx: FrameworkAnalysisContext, relativePath: string, facts: ParsedFactsBlob, resolver: SyntaxObservation): { name: string; refs: FrameworkEvidence["refs"] } | undefined {
  const nodes = new Map(facts.frameworkSyntax?.nodes.map((node) => [node.id, node]));
  if (resolver.arguments.length === 0 || resolver.arguments.length > 2) return undefined;
  const argument = nodes.get(resolver.arguments[0]!.valueId);
  const declared = literal(argument);
  if (declared !== undefined) return resolver.arguments.length === 1 ? { name: declared, refs: [] } : undefined;
  let type = argument;
  if (type?.kind === "lambda") {
    const children = type.children.map((id) => nodes.get(id));
    if (children.length !== 1 || children[0]?.kind !== "return" || children[0].children.length !== 1) return undefined;
    type = nodes.get(children[0].children[0]!);
  }
  if (type?.kind !== "identifier" || !type.name || type.children.length !== 0) return undefined;
  if (resolver.arguments.length === 2 && nodes.get(resolver.arguments[1]!.valueId)?.kind !== "object") return undefined;
  let targetFacts = facts;
  let targetPath = relativePath;
  let typeName = type.name;
  const imports = facts.imports.filter((item) => item.localName === typeName);
  if (imports.length > 0) {
    if (imports.length !== 1 || imports[0]!.kind !== "named" || !imports[0]!.moduleSpecifier.startsWith(".")) return undefined;
    if (facts.symbols.some((item) => item.name === typeName)) return undefined;
    const imported = imports[0]!;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), imported.moduleSpecifier)).replace(/\.js$/, "");
    const targets = ctx.facts.filter((item) => [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].includes(item.relativePath));
    if (targets.length !== 1) return undefined;
    targetFacts = targets[0]!.facts;
    targetPath = targets[0]!.relativePath;
    const exports = targetFacts.exports.filter((item) => item.exportedName === imported.importedName && !item.moduleSpecifier);
    if (exports.length !== 1 || !exports[0]!.localName) return undefined;
    typeName = exports[0]!.localName;
  }
  if (!targetFacts.frameworkSyntax?.complete || targetFacts.bindingSeeds.some((item) => item.name === typeName && item.bindingKind !== "import")) return undefined;
  const classes = targetFacts.symbols.filter((item) => item.name === typeName && item.kind === "class");
  if (classes.length !== 1) return undefined;
  const decorators = targetFacts.frameworkSyntax.nodes.filter((item) => item.kind === "annotation" && item.ownerSymbolId === classes[0]!.localId
    && ["ObjectType", "InterfaceType"].includes(frameworkImportedName(targetFacts, item.name, "@nestjs/graphql") ?? ""));
  if (decorators.length !== 1) return undefined;
  const decorator = decorators[0]!;
  const targetNodes = new Map(targetFacts.frameworkSyntax.nodes.map((item) => [item.id, item]));
  const first = decorator.arguments[0] && targetNodes.get(decorator.arguments[0].valueId);
  if (decorator.arguments.length > 2 || (first && first.kind !== "literal" && first.kind !== "object")
    || (decorator.arguments.length === 2 && (first?.kind !== "literal" || targetNodes.get(decorator.arguments[1]!.valueId)?.kind !== "object"))) return undefined;
  const name = first?.kind === "literal" ? literal(first) : typeName;
  return name === undefined ? undefined : { name, refs: [{ relativePath: targetPath, inputKey: `facts:${targetPath}`, localId: decorator.id, range: decorator.range }] };
}

export const nestjsAdapter: FrameworkSemanticAdapter = {
  id: "nestjs", version: "1.2.0", frameworks: ["nestjs"], detect,
  analyze: (ctx: FrameworkAnalysisContext): { evidence: readonly FrameworkEvidence[]; dependencies: readonly { framework: "nestjs"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[] } => {
    const evidence: FrameworkEvidence[] = [];
    const dependencies: { framework: "nestjs"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[] = [];
    for (const materialized of ctx.facts) {
      if (!materialized.facts.imports.some((item) => item.moduleSpecifier === "@nestjs/common" || item.moduleSpecifier.startsWith("@nestjs/"))) continue;
      const syntax = materialized.facts.frameworkSyntax;
      if (!syntax) continue;
      const nodes = new Map(syntax.nodes.map((node) => [node.id, node]));
      const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
      const moduleAnnotations = syntax.nodes.filter((node) => node.kind === "annotation" && node.name === "Module");
      const annotations = syntax.nodes.filter((node) => node.kind === "annotation");
      const annotationById = new Map(syntax.nodes.map((node) => [node.id, node]));
      const nodeOwner = (annotation: typeof syntax.nodes[number]) => annotation.ownerSymbolId ? graphNodes.filter((node) => node.id === annotation.ownerSymbolId) : [];
      const graphqlDecorator = (name: string | undefined, expected: string): boolean => frameworkImportedName(materialized.facts, name, "@nestjs/graphql") === expected;
      const resolverClasses = new Set<string>(annotations.flatMap((item) => {
        const owner = graphqlDecorator(item.name, "Resolver")
          ? frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, item.ownerSymbolId, "class") : undefined;
        return owner ? [owner.id] : [];
      }));
      const graphqlEvidence: FrameworkEvidence[] = [];
      for (const annotation of annotations) {
        const operationKind = graphqlDecorator(annotation.name, "Query") ? "query" : graphqlDecorator(annotation.name, "Mutation") ? "mutation"
          : graphqlDecorator(annotation.name, "Subscription") ? "subscription" : graphqlDecorator(annotation.name, "ResolveField") ? "field" : undefined;
        if (!operationKind) {
          const imported = materialized.facts.imports.find((item) => item.localName === annotation.name && item.moduleSpecifier === "@nestjs/graphql");
          if (imported?.kind === "namespace" || ["Query", "Mutation", "Subscription", "ResolveField"].includes(imported?.importedName ?? "")) {
            graphqlEvidence.push({ evidenceId: `nestjs-graphql:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.2.0",
              strategy: "resolver.import-unsupported", capability: "nestjs.graphql", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact",
              refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }],
              entities: [], applicable: true, supported: false, attempted: true, state: "unsupported", outputKind: "relationship", relationKind: "graphql_resolver", sourceCandidates: [], targetCandidates: [] });
          }
          continue;
        }
        const owner = frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, "method");
        const ownerClass = frameworkEnclosingClass(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, owner);
        const methodName = owner?.name ?? materialized.facts.symbols.find((item) => item.localId === annotation.ownerSymbolId && item.kind === "method")?.name;
        const resolverAnnotations = annotations.filter((item) => graphqlDecorator(item.name, "Resolver")
          && frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, item.ownerSymbolId, "class")?.id === ownerClass?.id);
        const parent = operationKind === "field" && resolverAnnotations.length === 1
          ? resolverParent(ctx, materialized.relativePath, materialized.facts, resolverAnnotations[0]!) : undefined;
        const fieldName = methodName && graphqlName(annotation, annotationById, methodName, operationKind === "field");
        const ref = fieldName && (operationKind !== "field" || parent) ? { framework: "nestjs" as const, kind: operationKind === "field" ? "graphql_field" as const : "graphql_operation" as const,
          logicalKey: JSON.stringify(operationKind === "field" ? ["root", parent!.name, fieldName] : ["root", operationKind, fieldName]) } : undefined;
        let accepted = !!ref && !!ownerClass && resolverClasses.has(ownerClass.id) && resolverAnnotations.length === 1 && syntax.complete;
        if (accepted && ref) {
          try { frameworkEntityKey(ref); } catch { accepted = false; }
        }
        const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range },
          ...resolverAnnotations.map((item) => ({ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: item.id, range: item.range })), ...(parent?.refs ?? [])];
        graphqlEvidence.push({
          evidenceId: `nestjs-graphql:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.2.0",
          strategy: operationKind === "field" ? "resolver.resolve-field" : operationKind === "subscription" ? "resolver.subscription" : "resolver.operation", capability: "nestjs.graphql", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs,
          entities: accepted && ref && ownerClass ? [{ ref, displayName: `${operationKind}.${fieldName} (${ownerClass.qualifiedName ?? ownerClass.name})`, declarationKey: `graphql:${materialized.relativePath}:${annotation.id}`, confidence: "exact", refs }] : [],
          applicable: true, supported: true, attempted: true, state: accepted && owner ? "candidate" : "unknown",
          outputKind: "relationship", relationKind: "graphql_resolver",
          sourceCandidates: accepted && owner ? [{ kind: "language", nodeId: owner.id }] : [],
          targetCandidates: accepted && ref ? [{ kind: "framework", entity: ref }] : [],
        });
      }
      const routeAnnotations: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Options: "OPTIONS", Head: "HEAD", All: "ALL" };
      for (const annotation of annotations) {
        const method = annotation.name ? routeAnnotations[annotation.name] : undefined;
        if (!method) continue;
        const owner = nodeOwner(annotation).find((node) => node.type === "method");
        const ownerClass = owner && graphNodes.find((node) => node.type === "class" && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === owner.id));
        const controller = ownerClass && annotations.find((candidate) => candidate.name === "Controller" && candidate.ownerSymbolId === ownerClass.id);
        if (!owner || !ownerClass || !controller) continue;
        const argument = annotation.arguments[0];
        const path = argument ? literal(annotationById.get(argument.valueId)) : "";
        if (path === undefined) continue;
        const prefix = literal(annotationById.get(controller.arguments[0]?.valueId ?? "")) ?? "";
        const routePath = prefix ? `${prefix}/${path}` : (path.startsWith("/") ? path : `/${path}`);
        if (routePath.includes("//") || routePath.split("/").some((segment) => segment === "." || segment === "..")) continue;
        const canonical = canonicalizeNestRoute({ framework: "nestjs", scope: "root", router: "http", kind: "route", path: routePath, method, conditions: [], owner: owner.qualifiedName ?? owner.name ?? null });
        if (canonical.kind !== "canonical" || !owner) continue;
        const entity = { ref: canonical.ref, displayName: canonical.ref.logicalKey, declarationKey: `route:${materialized.relativePath}:${annotation.id}`, confidence: "exact" as const, refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }] };
        evidence.push({ evidenceId: `nestjs-route:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.2.0", strategy: "controller-route", capability: "nestjs.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: entity.refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "controller_route", sourceCandidates: [{ kind: "language", nodeId: owner.id }], targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      }
      const lookupKeys: string[] = [];
      const names = (id: string): string[] => {
        const node = nodes.get(id);
        if (!node) return [];
        return [
          ...(node.name ? [node.name] : []),
          ...node.children.flatMap(names),
          ...node.arguments.flatMap((argument) => names(argument.valueId)),
        ];
      };
      for (const annotation of moduleAnnotations) {
        const moduleOwner = annotation.ownerSymbolId ? graphNodes.filter((node) => node.id === annotation.ownerSymbolId && node.type === "class") : [];
        const object = annotation.children.map((id) => nodes.get(id)).find((node) => node?.kind === "object");
        for (const propertyId of object?.children ?? []) {
          const property = nodes.get(propertyId);
          if (!property?.name || !["controllers", "providers", "imports", "exports"].includes(property.name)) continue;
          const targetNames = [...new Set(property.children.flatMap(names))].filter((name) => name !== property.name);
          lookupKeys.push(...targetNames.map((name) => `module:${property.name}:${name}`));
          for (const targetName of targetNames) {
            const targets = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === targetName).map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
            evidence.push({ evidenceId: `nestjs-module:${materialized.relativePath}:${annotation.id}:${property.name}:${targetName}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.2.0", strategy: `module.${property.name}`, capability: "nestjs.modules", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: property.name === "controllers" ? "module_provider" : property.name === "providers" ? "module_provider" : "module_provider", sourceCandidates: moduleOwner.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: targets });
          }
        }
      }
      for (const parameter of materialized.facts.parameters ?? []) {
        if (!parameter.typeText || !parameter.ownerSymbolId) continue;
        const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId);
        const providers = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === parameter.typeText);
        lookupKeys.push(`inject:${parameter.typeText}`);
        evidence.push({ evidenceId: `nestjs-inject:${materialized.relativePath}:${parameter.localId}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.2.0", strategy: "constructor.type", capability: "nestjs.injection", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: parameter.localId, range: parameter.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: providers.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })) });
      }
      evidence.push(...graphqlEvidence);
      dependencies.push({ framework: "nestjs", scope: "root", ownerPath: materialized.relativePath, inputKeys: [...new Set([`facts:${materialized.relativePath}`, ...graphqlEvidence.flatMap((item) => item.refs.map((ref) => ref.inputKey))])].sort(), lookupKeys: [...new Set(lookupKeys)].sort(), complete: syntax.complete });
    }
    return { evidence, dependencies };
  },
};

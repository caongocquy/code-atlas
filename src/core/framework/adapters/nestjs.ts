import { frameworkEntityKey } from "../framework-identity.js";
import { frameworkEnclosingClass, frameworkGraphSymbol } from "../framework-symbol-binding.js";
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

function graphqlName(annotation: { arguments: readonly { valueId: string }[] }, nodes: Map<string, { kind: string; name?: string; value?: string | number | boolean | null; children: readonly string[] }>, fallback: string): string | undefined {
  if (annotation.arguments.length > 2) return undefined;
  const first = annotation.arguments[0] && nodes.get(annotation.arguments[0].valueId);
  if (annotation.arguments.length > 0 && !first) return undefined;
  if (first?.kind === "literal") return annotation.arguments.length === 1 ? literal(first) : undefined;
  if (first && first.kind !== "lambda") return undefined;
  const options = annotation.arguments[1] && nodes.get(annotation.arguments[1].valueId);
  if (annotation.arguments.length === 2 && !options) return undefined;
  if (options && options.kind !== "object") return undefined;
  const properties = options?.children.map((id) => nodes.get(id)) ?? [];
  if (properties.some((node) => !node || node.kind !== "property")) return undefined;
  const names = properties.filter((node) => node?.name === "name");
  if (names.length > 1) return undefined;
  return names.length === 0 ? fallback : literal(nodes.get(names[0]!.children[0] ?? ""));
}

export const nestjsAdapter: FrameworkSemanticAdapter = {
  id: "nestjs", version: "1.1.0", frameworks: ["nestjs"], detect,
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
      const graphqlImports = new Map(materialized.facts.imports.filter((item) => item.moduleSpecifier === "@nestjs/graphql" && item.kind === "named").map((item) => [item.localName, item.importedName]));
      const graphqlDecorator = (name: string | undefined, expected: string): boolean => !!name && graphqlImports.get(name) === expected;
      const resolverClasses = new Set<string>(annotations.flatMap((item) => {
        const owner = graphqlDecorator(item.name, "Resolver")
          ? frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, item.ownerSymbolId, "class") : undefined;
        return owner ? [owner.id] : [];
      }));
      const graphqlEvidence: FrameworkEvidence[] = [];
      for (const annotation of annotations) {
        const operationKind = graphqlDecorator(annotation.name, "Query") ? "query" : graphqlDecorator(annotation.name, "Mutation") ? "mutation" : undefined;
        const excluded = ["Subscription", "ResolveField"].some((name) => graphqlDecorator(annotation.name, name));
        if (!operationKind && !excluded) continue;
        const owner = frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, "method");
        const ownerClass = frameworkEnclosingClass(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, owner);
        const methodName = owner?.name ?? materialized.facts.symbols.find((item) => item.localId === annotation.ownerSymbolId && item.kind === "method")?.name;
        const fieldName = operationKind && methodName && graphqlName(annotation, annotationById, methodName);
        const ref = fieldName && operationKind ? { framework: "nestjs" as const, kind: "graphql_operation" as const, logicalKey: JSON.stringify(["root", operationKind, fieldName]) } : undefined;
        let accepted = !!ref && !!ownerClass && resolverClasses.has(ownerClass.id) && syntax.complete;
        if (accepted && ref) {
          try { frameworkEntityKey(ref); } catch { accepted = false; }
        }
        const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }];
        graphqlEvidence.push({
          evidenceId: `nestjs-graphql:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.1.0",
          strategy: "resolver.operation", capability: "nestjs.graphql", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs,
          entities: accepted && ref && ownerClass ? [{ ref, displayName: `${operationKind}.${fieldName} (${ownerClass.qualifiedName ?? ownerClass.name})`, declarationKey: `graphql:${materialized.relativePath}:${annotation.id}`, confidence: "exact", refs }] : [],
          applicable: true, supported: !excluded, attempted: true, state: accepted && owner ? "candidate" : excluded ? "unsupported" : "unknown",
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
        evidence.push({ evidenceId: `nestjs-route:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.1.0", strategy: "controller-route", capability: "nestjs.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: entity.refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "controller_route", sourceCandidates: [{ kind: "language", nodeId: owner.id }], targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
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
            evidence.push({ evidenceId: `nestjs-module:${materialized.relativePath}:${annotation.id}:${property.name}:${targetName}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.1.0", strategy: `module.${property.name}`, capability: "nestjs.modules", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: property.name === "controllers" ? "module_provider" : property.name === "providers" ? "module_provider" : "module_provider", sourceCandidates: moduleOwner.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: targets });
          }
        }
      }
      for (const parameter of materialized.facts.parameters ?? []) {
        if (!parameter.typeText || !parameter.ownerSymbolId) continue;
        const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId);
        const providers = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === parameter.typeText);
        lookupKeys.push(`inject:${parameter.typeText}`);
        evidence.push({ evidenceId: `nestjs-inject:${materialized.relativePath}:${parameter.localId}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.1.0", strategy: "constructor.type", capability: "nestjs.injection", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: parameter.localId, range: parameter.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: providers.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })) });
      }
      evidence.push(...graphqlEvidence);
      dependencies.push({ framework: "nestjs", scope: "root", ownerPath: materialized.relativePath, inputKeys: [`facts:${materialized.relativePath}`], lookupKeys: [...new Set(lookupKeys)].sort(), complete: syntax.complete });
    }
    return { evidence, dependencies };
  },
};

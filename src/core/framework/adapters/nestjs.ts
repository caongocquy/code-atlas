import { frameworkEntityKey } from "../framework-identity.js";
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
  const refs = ctx.config.filter((item) => item.kind === "package").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "nestjs", scope: "root", configured, observed, capabilities: ["nestjs.routes", "nestjs.modules", "nestjs.injection"], refs, complete: ctx.config.every((item) => item.complete) }];
}

export const nestjsAdapter: FrameworkSemanticAdapter = {
  id: "nestjs", version: "1.0.0", frameworks: ["nestjs"], detect,
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
        evidence.push({ evidenceId: `nestjs-route:${materialized.relativePath}:${annotation.id}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.0.0", strategy: "controller-route", capability: "nestjs.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: entity.refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "controller_route", sourceCandidates: [{ kind: "language", nodeId: owner.id }], targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
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
            evidence.push({ evidenceId: `nestjs-module:${materialized.relativePath}:${annotation.id}:${property.name}:${targetName}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.0.0", strategy: `module.${property.name}`, capability: "nestjs.modules", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: property.name === "controllers" ? "module_provider" : property.name === "providers" ? "module_provider" : "module_provider", sourceCandidates: moduleOwner.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: targets });
          }
        }
      }
      for (const parameter of materialized.facts.parameters ?? []) {
        if (!parameter.typeText || !parameter.ownerSymbolId) continue;
        const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId);
        const providers = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === parameter.typeText);
        lookupKeys.push(`inject:${parameter.typeText}`);
        evidence.push({ evidenceId: `nestjs-inject:${materialized.relativePath}:${parameter.localId}`, framework: "nestjs", adapterId: "nestjs", adapterVersion: "1.0.0", strategy: "constructor.type", capability: "nestjs.injection", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: parameter.localId, range: parameter.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: providers.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })) });
      }
      dependencies.push({ framework: "nestjs", scope: "root", ownerPath: materialized.relativePath, inputKeys: [`facts:${materialized.relativePath}`], lookupKeys: [...new Set(lookupKeys)].sort(), complete: syntax.complete });
    }
    return { evidence, dependencies };
  },
};

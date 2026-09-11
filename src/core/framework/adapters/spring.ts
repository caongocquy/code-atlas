import { frameworkEntityKey } from "../framework-identity.js";
import type { DetectionResult, FrameworkAdapterResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSubjectRef } from "../framework.types.js";

export function canonicalizeSpringRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "spring") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Spring route" };
  const scope = input.scope;
  const router = input.router;
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || input.path.includes("\\") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "spring" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

const literal = (node: { kind: string; value?: string | number | boolean | null } | undefined): string | undefined =>
  node?.kind === "literal" && typeof node.value === "string" ? node.value : undefined;

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const configured = ctx.config.some((item) => item.kind === "maven" || item.kind === "gradle");
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier.startsWith("org.springframework")));
  if (!configured && !observed) return [];
  const refs = ctx.config.filter((item) => item.kind === "maven" || item.kind === "gradle").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "spring", scope: "root", configured, observed, capabilities: ["spring.routes", "spring.components", "spring.injection", "spring.beans"], refs, complete: ctx.config.every((item) => item.complete) }];
}

export function collectSpringBeanEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("org.springframework"))) continue;
    const annotations = materialized.facts.frameworkSyntax?.nodes.filter((node) => node.kind === "annotation" && node.name === "Bean") ?? [];
      const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
      for (const annotation of annotations) {
        const methods = annotation.ownerSymbolId ? graphNodes.filter((node) => node.id === annotation.ownerSymbolId && node.type === "method") : [];
        for (const method of methods) {
          const owners = graphNodes.filter((node) => node.type === "class" && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === method.id));
          evidence.push({ evidenceId: `spring-bean:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.0.0", strategy: "bean.factory-method", capability: "spring.beans", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "bean_relationship", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: [{ kind: "language", nodeId: method.id }] });
        }
      }
      const syntax = materialized.facts.frameworkSyntax;
      const nodes = new Map((syntax?.nodes ?? []).map((node) => [node.id, node]));
      const routeAnnotations: Record<string, string | null> = { RequestMapping: null, GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", PatchMapping: "PATCH", DeleteMapping: "DELETE" };
      const controllerAnnotations = new Set(["RestController", "Controller"]);
      if (!(syntax?.nodes ?? []).some((node) => node.kind === "annotation" && controllerAnnotations.has(node.name ?? ""))) continue;
      for (const annotation of syntax?.nodes ?? []) {
        const method = annotation.name ? routeAnnotations[annotation.name] : undefined;
        if (method === undefined) continue;
        const owner = annotation.ownerSymbolId ? graphNodes.find((node) => node.id === annotation.ownerSymbolId) : undefined;
        if (!owner) continue;
        const ownerClass = graphNodes.find((node) => node.type === "class" && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === owner.id));
        const controller = ownerClass && (syntax?.nodes ?? []).find((candidate) => ["RestController", "Controller"].includes(candidate.name ?? "") && candidate.ownerSymbolId === ownerClass.id);
        if (!ownerClass || !controller) continue;
        const classMapping = (syntax?.nodes ?? []).find((candidate) => candidate.name === "RequestMapping" && candidate.ownerSymbolId === ownerClass.id);
        const classPrefix = literal(nodes.get(classMapping?.arguments[0]?.valueId ?? "")) ?? "";
        const argument = annotation.arguments[0];
        const path = argument ? literal(nodes.get(argument.valueId)) : "";
        if (path === undefined) continue;
        const routePath = classPrefix ? `${classPrefix}/${path}` : (path.startsWith("/") ? path : `/${path}`);
        if (routePath.includes("//") || routePath.split("/").some((segment) => segment === "." || segment === "..")) continue;
        const canonical = canonicalizeSpringRoute({ framework: "spring", scope: "root", router: "mvc", kind: "route", path: routePath, method, conditions: [], owner: owner.qualifiedName ?? owner.name });
        if (canonical.kind !== "canonical") continue;
        const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }];
        const entity = { ref: canonical.ref, displayName: canonical.ref.logicalKey, declarationKey: `route:${materialized.relativePath}:${annotation.id}`, confidence: "exact" as const, refs };
        evidence.push({ evidenceId: `spring-route:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.0.0", strategy: "request-mapping", capability: "spring.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "controller_route", sourceCandidates: [{ kind: "language", nodeId: owner.id }], targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      }
  }
  return { evidence, dependencies: [] };
}

export function collectSpringInjectionEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("org.springframework"))) continue;
    const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    for (const parameter of materialized.facts.parameters ?? []) {
      if (!parameter.typeText || !parameter.ownerSymbolId) continue;
      const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId);
      const providers = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === parameter.typeText);
      evidence.push({ evidenceId: `spring-inject:${materialized.relativePath}:${parameter.localId}`, framework: "spring", adapterId: "spring", adapterVersion: "1.0.0", strategy: "autowired.constructor", capability: "spring.injection", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: parameter.localId, range: parameter.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: providers.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })) });
    }
  }
  return { evidence, dependencies: [] };
}

export const springAdapter: FrameworkSemanticAdapter = {
  id: "spring", version: "1.0.0", frameworks: ["spring"], detect,
  analyze: (ctx: FrameworkAnalysisContext): FrameworkAdapterResult => {
    const beans = collectSpringBeanEvidence(ctx);
    const injection = collectSpringInjectionEvidence(ctx);
    return { evidence: [...beans.evidence, ...injection.evidence], dependencies: [...beans.dependencies, ...injection.dependencies] };
  },
};

import { frameworkEntityKey } from "../framework-identity.js";
import type { DetectionResult, FrameworkAdapterResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSubjectRef } from "../framework.types.js";

export function canonicalizeSpringRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "spring") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Spring route" };
  const scope = input.scope.replaceAll("\\", "/");
  const router = input.router.replaceAll("\\", "/");
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "spring" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

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
        const methods = graphNodes.filter((node) => node.type === "method" && (node.startLine ?? 0) >= annotation.range.startLine && (node.startLine ?? 0) <= annotation.range.endLine + 1);
        for (const method of methods) {
          const owners = graphNodes.filter((node) => node.type === "class" && (node.startLine ?? 0) <= method.startLine! && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= (method.endLine ?? method.startLine ?? 0));
          evidence.push({ evidenceId: `spring-bean:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.0.0", strategy: "bean.factory-method", capability: "spring.beans", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "bean_relationship", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: [{ kind: "language", nodeId: method.id }] });
        }
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
      const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId || ((node.startLine ?? 0) <= parameter.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= parameter.range.endLine));
      const providers = graphNodes.filter((node) => node.name === parameter.typeText);
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

import { frameworkEntityKey } from "../framework-identity.js";
import type { DetectionResult, FrameworkAdapterResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSubjectRef } from "../framework.types.js";

export function canonicalizeFlutterRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "flutter") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Flutter route" };
  const scope = input.scope;
  const router = input.router;
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "flutter" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method, conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; } catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

function collectFlutterNavigationEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    const syntax = materialized.facts.frameworkSyntax;
    if (!syntax || !materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("package:flutter/"))) continue;
    const nodes = new Map(syntax.nodes.map((node) => [node.id, node]));
    const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    const routes = syntax.nodes.filter((node) => node.kind === "property" && typeof node.name === "string" && node.name.startsWith("/"));
    const routeEntities = routes.flatMap((route) => {
      const canonical = canonicalizeFlutterRoute({ framework: "flutter", scope: "root", router: "material:App", kind: "route", path: route.name!, method: null, conditions: [], owner: null });
      if (canonical.kind !== "canonical") return [];
      const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: route.id, range: route.range }];
      const entity = { ref: canonical.ref, displayName: route.name!, declarationKey: `route:${materialized.relativePath}:${route.id}`, confidence: "exact" as const, refs };
      evidence.push({ evidenceId: `flutter-route:${materialized.relativePath}:${route.id}`, framework: "flutter", adapterId: "flutter", adapterVersion: "1.0.0", strategy: "material.routes", capability: "flutter.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "route_binding", sourceCandidates: graphNodes.filter((node) => node.type !== "file" && (node.startLine ?? 0) <= route.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= route.range.endLine).map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      return [{ route, ref: canonical.ref }];
    });
    for (const call of syntax.nodes.filter((node) => node.kind === "call" && node.name === "pushNamed")) {
      const routeName = nodes.get(call.arguments[0]?.valueId)?.value;
      if (typeof routeName !== "string") continue;
      const targets = routeEntities.filter((route) => JSON.parse(route.ref.logicalKey)[2] === routeName);
      const sources = call.ownerSymbolId ? graphNodes.filter((node) => node.id === call.ownerSymbolId) : graphNodes.filter((node) => node.type !== "file" && (node.startLine ?? 0) <= call.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= call.range.endLine);
      evidence.push({ evidenceId: `flutter-navigation:${materialized.relativePath}:${call.id}`, framework: "flutter", adapterId: "flutter", adapterVersion: "1.0.0", strategy: "navigator.pushNamed", capability: "flutter.navigation", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: call.id, range: call.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "navigation_binding", sourceCandidates: sources.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: targets.map((route) => ({ kind: "framework", entity: route.ref })) });
    }
  }
  return { evidence, dependencies: [] };
}

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const configured = ctx.config.some((item) => item.kind === "pubspec" && Object.hasOwn(item.values, "flutter"));
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier.startsWith("package:flutter/")));
  if (!configured && !observed) return [];
  const refs = ctx.config.filter((item) => item.kind === "pubspec").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "flutter", scope: "root", configured, observed, capabilities: ["flutter.widgets", "flutter.navigation", "flutter.routes", "flutter.provider", "flutter.bloc"], refs, complete: ctx.config.every((item) => item.complete) }];
}

export function collectFlutterProviderEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    const imports = materialized.facts.imports.map((item) => item.moduleSpecifier);
    const hasProvider = imports.some((item) => item === "package:provider/provider.dart");
    const hasBloc = imports.some((item) => item === "package:flutter_bloc/flutter_bloc.dart");
    if (!hasProvider && !hasBloc) continue;
    const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    for (const node of materialized.facts.frameworkSyntax?.nodes ?? []) {
      if (node.kind !== "construct" || !node.name) continue;
      const providerKind = hasBloc && node.name.includes("BlocProvider") ? "flutter.bloc" : hasProvider && ["Provider", "ChangeNotifierProvider", "RepositoryProvider"].includes(node.name) ? "flutter.provider" : undefined;
      if (!providerKind) continue;
      const targets = graphNodes.filter((candidate) => candidate.name === node.name || candidate.name === node.typeArguments.map((id) => (materialized.facts.frameworkSyntax?.nodes ?? []).find((item) => item.id === id)?.name).find(Boolean));
      evidence.push({ evidenceId: `flutter-provider:${materialized.relativePath}:${node.id}`, framework: "flutter", adapterId: "flutter", adapterVersion: "1.0.0", strategy: providerKind, capability: providerKind, relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: node.id, range: node.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: graphNodes.filter((candidate) => candidate.startLine !== undefined && candidate.startLine <= node.range.startLine && (candidate.endLine ?? Number.MAX_SAFE_INTEGER) >= node.range.endLine).map((candidate): FrameworkSubjectRef => ({ kind: "language", nodeId: candidate.id })), targetCandidates: targets.map((candidate): FrameworkSubjectRef => ({ kind: "language", nodeId: candidate.id })) });
    }
  }
  return { evidence, dependencies: [] };
}

export const flutterAdapter: FrameworkSemanticAdapter = {
  id: "flutter", version: "1.0.0", frameworks: ["flutter"], detect,
  analyze: (ctx) => {
    const evidence: FrameworkEvidence[] = [];
    for (const materialized of ctx.facts) {
      if (!materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("package:flutter/"))) continue;
      const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
      for (const node of materialized.facts.frameworkSyntax?.nodes ?? []) {
        if (node.kind !== "construct" || !node.name || /^[a-z]/.test(node.name)) continue;
        const targets = graphNodes.filter((candidate) => candidate.name === node.name);
        const sources = graphNodes.filter((candidate) => (candidate.startLine ?? 0) <= node.range.startLine && (candidate.endLine ?? Number.MAX_SAFE_INTEGER) >= node.range.endLine);
        evidence.push({ evidenceId: `flutter-widget:${materialized.relativePath}:${node.id}`, framework: "flutter", adapterId: "flutter", adapterVersion: "1.0.0", strategy: "widget-constructor", capability: "flutter.widgets", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: node.id, range: node.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "widget_composition", sourceCandidates: sources.map((candidate): FrameworkSubjectRef => ({ kind: "language", nodeId: candidate.id })), targetCandidates: targets.map((candidate): FrameworkSubjectRef => ({ kind: "language", nodeId: candidate.id })) });
      }
    }
    const providers = collectFlutterProviderEvidence(ctx);
    const navigation = collectFlutterNavigationEvidence(ctx);
    return { evidence: [...evidence, ...providers.evidence, ...navigation.evidence], dependencies: [...providers.dependencies, ...navigation.dependencies] };
  },
};

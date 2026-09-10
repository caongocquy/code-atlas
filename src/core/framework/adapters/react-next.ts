import { frameworkEntityKey } from "../framework-identity.js";
import type {
  DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence,
  FrameworkEvidenceRef, FrameworkSemanticAdapter, FrameworkSubjectRef,
} from "../framework.types.js";

const refsFor = (relativePath: string, inputKey: string): FrameworkEvidenceRef[] => [{ relativePath, inputKey }];

export function canonicalizeNextRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "next") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Next route" };
  const scope = input.scope.replaceAll("\\", "/");
  const router = input.router.replaceAll("\\", "/");
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "next" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path.replaceAll("\\", "/"), input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const config = ctx.config.filter((item) => item.kind === "package");
  const configured = config.some((item) => Object.keys(item.values).some((key) => key === "next" || key === "react"));
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "react" || value.moduleSpecifier === "next" || value.moduleSpecifier.startsWith("next/")));
  if (!configured && !observed) return [];
  const refs = config.flatMap((item) => refsFor(item.relativePath, item.inputKey));
  return [
    { framework: "react", scope: "root", configured, observed, capabilities: ["react.component_usage"], refs, complete: config.every((item) => item.complete) },
    { framework: "next", scope: "root", configured: configured && config.some((item) => Object.hasOwn(item.values, "next")), observed: observed && ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "next" || value.moduleSpecifier.startsWith("next/"))), capabilities: ["next.app_routes", "next.pages_routes", "next.layout_binding", "next.execution_boundary"], refs, complete: config.every((item) => item.complete) },
  ];
}

function analyze(ctx: FrameworkAnalysisContext): { evidence: readonly FrameworkEvidence[]; dependencies: readonly { framework: "react" | "next"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[] } {
  const evidence: FrameworkEvidence[] = [];
  const dependencies = [] as { framework: "react" | "next"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[];
  for (const materialized of ctx.facts) {
    const syntax = materialized.facts.frameworkSyntax;
    if (!syntax) continue;
    const localNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    const inputKey = `facts:${materialized.relativePath}`;
    const jsxNodes = syntax.nodes.filter((node) => node.kind === "jsx" && typeof node.name === "string" && node.name.length > 0);
    const lookupKeys = jsxNodes.map((node) => `jsx:${node.name}`).sort();
    dependencies.push({ framework: "react", scope: "root", ownerPath: materialized.relativePath, inputKeys: [inputKey], lookupKeys, complete: syntax.complete });
    for (const jsx of jsxNodes) {
      if (!jsx.name || /^[a-z]/.test(jsx.name)) continue;
      const targetName = jsx.name.split(".").at(-1);
      const targets = localNodes.filter((node) => node.name === targetName).map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      const source = localNodes.filter((node) => (node.startLine ?? 0) <= jsx.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= jsx.range.endLine)
        .map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      evidence.push({
        evidenceId: `react-jsx:${materialized.relativePath}:${jsx.id}`,
        framework: "react", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "jsx-component-usage", capability: "react.component_usage",
        relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: refsFor(materialized.relativePath, inputKey), entities: [], applicable: true, supported: true, attempted: true, state: "candidate",
        outputKind: "relationship", relationKind: "component_usage", sourceCandidates: source, targetCandidates: targets,
      });
    }
    const nextFile = materialized.relativePath.replaceAll("\\", "/");
    const routeMatch = /^(?:app|pages)\/(.*)\/(page|layout|route)\.(?:tsx?|jsx?)$/.exec(nextFile)
      ?? /^(?:app|pages)\/(page|layout|route)\.(?:tsx?|jsx?)$/.exec(nextFile);
    if (routeMatch) {
      const router = nextFile.startsWith("app/") ? "app" : "pages";
      const fileKind = routeMatch[2] ?? routeMatch[1];
      const routeSegments = (routeMatch[2] ? routeMatch[1] : "").split("/").filter(Boolean).filter((segment) => !/^\([^)]*\)$/.test(segment));
      const routePath = `/${routeSegments.join("/")}`.replace(/\/+/g, "/");
      const kind = fileKind === "layout" ? "layout" as const : "route" as const;
      const canonical = canonicalizeNextRoute({ framework: "next", scope: "root", router, kind, path: routePath === "/" ? "/" : routePath, method: fileKind === "route" ? null : null, conditions: [], owner: null });
      if (canonical.kind === "canonical") {
        const entity = { ref: canonical.ref, displayName: routePath, declarationKey: `route:${nextFile}`, confidence: "exact" as const, refs: refsFor(nextFile, inputKey) };
        const fileNodes = localNodes.filter((node) => node.type === "file").map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
        evidence.push({ evidenceId: `next-route:${nextFile}`, framework: "next", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "next-route-convention", capability: "next.app_routes", relativePath: nextFile, origin: "framework_inferred", confidence: "exact", refs: entity.refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "route_binding", sourceCandidates: fileNodes, targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      }
    }
    const directives = syntax.nodes.filter((node) => node.kind === "directive" && (node.name === "use client" || node.name === "use server"));
    for (const directive of directives) {
      const subjects = localNodes.filter((node) => node.type !== "file" && (node.startLine ?? 0) <= directive.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= directive.range.endLine)
        .map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      evidence.push({ evidenceId: `next-directive:${nextFile}:${directive.id}`, framework: "next", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "next-execution-directive", capability: "next.execution_boundary", relativePath: nextFile, origin: "framework_inferred", confidence: "exact", refs: refsFor(nextFile, inputKey), entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "classification", classificationKind: "execution_boundary", subjectCandidates: subjects, values: [directive.name === "use client" ? "client" : "server"] });
    }
  }
  return { evidence, dependencies };
}

export const reactNextAdapter: FrameworkSemanticAdapter = {
  id: "react-next",
  version: "1.0.0",
  frameworks: ["react", "next"],
  detect,
  analyze,
};

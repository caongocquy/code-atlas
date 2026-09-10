import { frameworkEntityKey } from "../framework-identity.js";
import type { DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter } from "../framework.types.js";

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

export const springAdapter: FrameworkSemanticAdapter = {
  id: "spring", version: "1.0.0", frameworks: ["spring"], detect,
  analyze: (_ctx: FrameworkAnalysisContext): { evidence: readonly FrameworkEvidence[]; dependencies: readonly never[] } => ({ evidence: [], dependencies: [] }),
};

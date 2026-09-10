import { frameworkEntityKey } from "../framework-identity.js";
import type { DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter } from "../framework.types.js";

export function canonicalizeNestRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "nestjs") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Nest route" };
  const scope = input.scope.replaceAll("\\", "/");
  const router = input.router.replaceAll("\\", "/");
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "nestjs" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const configured = ctx.config.some((item) => item.kind === "package" && Object.hasOwn(item.values, "@nestjs/common"));
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "@nestjs/common" || value.moduleSpecifier.startsWith("@nestjs/")));
  if (!configured && !observed) return [];
  const refs = ctx.config.filter((item) => item.kind === "package").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "nestjs", scope: "root", configured, observed, capabilities: ["nestjs.routes", "nestjs.modules", "nestjs.injection"], refs, complete: ctx.config.every((item) => item.complete) }];
}

export const nestjsAdapter: FrameworkSemanticAdapter = {
  id: "nestjs", version: "1.0.0", frameworks: ["nestjs"], detect,
  analyze: (_ctx: FrameworkAnalysisContext): { evidence: readonly FrameworkEvidence[]; dependencies: readonly never[] } => ({ evidence: [], dependencies: [] }),
};

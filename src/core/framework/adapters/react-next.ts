import { canonicalizeFrameworkEntity } from "../framework-registry.js";
import type {
  DetectionResult, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidenceRef,
  FrameworkSemanticAdapter,
} from "../framework.types.js";

const refsFor = (relativePath: string, inputKey: string): FrameworkEvidenceRef[] => [{ relativePath, inputKey }];

export function canonicalizeNextRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "next") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Next route" };
  return canonicalizeFrameworkEntity({
    ...input,
    scope: input.scope.replaceAll("\\", "/"),
    router: input.router.replaceAll("\\", "/"),
    path: input.path.replaceAll("\\", "/"),
  });
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

export const reactNextAdapter: FrameworkSemanticAdapter = {
  id: "react-next",
  version: "1.0.0",
  frameworks: ["react", "next"],
  detect,
  analyze: () => ({ evidence: [], dependencies: [] }),
};

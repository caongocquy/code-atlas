import { createHash } from "node:crypto";

import { createCoverageDiagnostics, mergeCoverageDiagnostics } from "../diagnostics/coverage-diagnostics.service.js";
import type { CoverageDiagnostics } from "../diagnostics/coverage-diagnostics.types.js";
import { compareGraphDeltaContext, readGraphDeltaContext, structuralEdges } from "../change/graph-delta.service.js";
import type { GraphDeltaContext } from "../change/graph-delta.service.js";
import type { StructuralEdge, StructuralReference } from "../change/graph-delta.types.js";
import { graphNodeById } from "../change/transient-graph.js";
import type { CodeGraph } from "../graph/types.js";
import { attributeArchitectureCause } from "./architecture-cause.js";
import { evaluateArchitectureEdge, type ArchitectureEdgeDecision, type ArchitecturePolicy, type ArchitectureSeverity } from "./architecture-policy.js";
import { loadArchitecturePolicySnapshots, type ArchitecturePolicyPair } from "./architecture-policy-snapshot.js";
import type { ArchitectureDriftInput, ArchitectureDriftResult, ArchitectureEvidence, ArchitectureFinding } from "./architecture-drift.types.js";

export type ArchitectureEvaluation = Pick<ArchitectureDriftResult, "introduced" | "resolved" | "diagnostics" | "mayBeIncomplete" | "authoritativeNegativeResults" | "reasons" | "summary">;

function text(reference: StructuralReference): string {
  return "symbolId" in reference ? `${reference.file}:${reference.qualifiedName ?? reference.name}` : reference.file;
}

function findingId(parts: readonly string[]): string {
  return `architecture:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|test|tests)(\/|$)|\.(test|spec)\./.test(file.replaceAll("\\", "/"));
}

function referenceKey(reference: StructuralReference, renames = new Map<string, string>()): string {
  const file = renames.get(reference.file) ?? reference.file;
  return "symbolId" in reference
    ? `symbol:${file}:${reference.kind}:${reference.qualifiedName ?? reference.name}`
    : `file:${file}`;
}

function edgeKey(edge: StructuralEdge, renames = new Map<string, string>()): string {
  return `${edge.kind}:${referenceKey(edge.from, renames)}>${referenceKey(edge.to, renames)}`;
}

function edgesByKey(context: GraphDeltaContext): { before: Map<string, StructuralEdge>; after: Map<string, StructuralEdge> } {
  return {
    before: new Map(structuralEdges(context.before.graph).map((edge) => [edgeKey(edge, context.renames), edge])),
    after: new Map(structuralEdges(context.after.graph).map((edge) => [edgeKey(edge), edge])),
  };
}

function policyViolation(policy: ArchitecturePolicy, edge: StructuralEdge): { violated: boolean; decision: ArchitectureEdgeDecision } {
  const decision = evaluateArchitectureEdge(policy, edge);
  const production = !isTestFile(edge.from.file) || !isTestFile(edge.to.file);
  return {
    decision,
    violated: decision.action === "deny" || (decision.action === "unclassified" && policy.requireClassification && production),
  };
}

function edgeFinding(edge: StructuralEdge, decision: ArchitectureEdgeDecision, status: "introduced" | "resolved", cause: ArchitectureFinding["cause"]): ArchitectureFinding {
  const fromText = text(edge.from);
  const toText = text(edge.to);
  const rule = decision.rule;
  const kind = decision.action === "unclassified" ? "unclassified_dependency" : "forbidden_dependency";
  const message = rule?.message ?? (kind === "unclassified_dependency" ? "Structural dependency could not be classified by the architecture policy." : `Architecture rule ${rule?.id ?? "default"} denies this dependency.`);
  return {
    id: findingId([kind, edge.kind, fromText, toText]),
    kind,
    status,
    cause,
    severity: rule?.severity ?? "medium",
    ...(rule?.id ? { ruleId: rule.id } : {}),
    message,
    from: edge.from,
    to: edge.to,
    ...(decision.from.state === "classified" ? { fromGroup: decision.from.groupId } : {}),
    ...(decision.to.state === "classified" ? { toGroup: decision.to.groupId } : {}),
    edgeKind: edge.kind,
    evidence: [{ kind: "graph_delta_edge", status, edgeKind: edge.kind, from: fromText, to: toText, source: "transient_source_analysis" }],
    confidence: "high",
  };
}

function fileGraph(graph: CodeGraph): Map<string, Set<string>> {
  const nodes = graphNodeById(graph);
  const result = new Map<string, Set<string>>();
  for (const node of graph.nodes) if (node.type === "file") result.set(node.file, new Set());
  for (const edge of graph.edges) {
    if (edge.type !== "imports") continue;
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from?.type !== "file" || to?.type !== "file") continue;
    result.get(from.file)?.add(to.file);
  }
  return result;
}

function renameFileGraph(graph: Map<string, Set<string>>, renames: Map<string, string>): Map<string, Set<string>> {
  const renamed = new Map<string, Set<string>>();
  for (const [file, targets] of graph) {
    const targetFile = renames.get(file) ?? file;
    const values = renamed.get(targetFile) ?? new Set<string>();
    for (const target of targets) values.add(renames.get(target) ?? target);
    renamed.set(targetFile, values);
  }
  return renamed;
}

function stronglyConnected(graph: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indexes = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indexes.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!indexes.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, indexes.get(target)!));
    }
    if (low.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    let target: string;
    do {
      target = stack.pop()!;
      onStack.delete(target);
      component.push(target);
    } while (target !== node);
    components.push(component.sort());
  };
  for (const node of [...graph.keys()].sort()) if (!indexes.has(node)) visit(node);
  return components.filter((component) => component.length > 1 || graph.get(component[0]!)?.has(component[0]!));
}

function cyclePath(graph: Map<string, Set<string>>, component: readonly string[]): string[] {
  const members = new Set(component);
  const start = [...component].sort()[0]!;
  if (graph.get(start)?.has(start)) return [start, start];
  const visit = (node: string, current: string[], seen: Set<string>): string[] | undefined => {
    for (const target of [...(graph.get(node) ?? [])].filter((value) => members.has(value)).sort()) {
      if (target === start) return [...current, start];
      if (!seen.has(target)) {
        const result = visit(target, [...current, target], new Set([...seen, target]));
        if (result) return result;
      }
    }
    return undefined;
  };
  return visit(start, [start], new Set([start])) ?? [...component, start];
}

function cycleMap(graph: Map<string, Set<string>>): Map<string, string[]> {
  return new Map(stronglyConnected(graph).map((component) => [component.join("\0"), component]));
}

function cycleFindings(
  context: GraphDeltaContext,
  policies: Pick<ArchitecturePolicyPair, "baseline" | "target">,
): { introduced: ArchitectureFinding[]; resolved: ArchitectureFinding[] } {
  const beforeGraph = renameFileGraph(fileGraph(context.before.graph), context.renames);
  const afterGraph = fileGraph(context.after.graph);
  const before = cycleMap(beforeGraph);
  const after = cycleMap(afterGraph);
  const introduced: ArchitectureFinding[] = [];
  const resolved: ArchitectureFinding[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const beforeCycle = before.has(key);
    const afterCycle = after.has(key);
    const baselineActive = beforeCycle && policies.baseline.policy.cyclesEnabled;
    const targetActive = afterCycle && policies.target.policy.cyclesEnabled;
    if (baselineActive === targetActive) continue;
    const status = targetActive ? "introduced" : "resolved";
    const graphChanged = beforeCycle !== afterCycle;
    const policyChanged = policies.baseline.policy.cyclesEnabled !== policies.target.policy.cyclesEnabled;
    const graph = targetActive ? afterGraph : beforeGraph;
    const component = (targetActive ? after.get(key) : before.get(key))!;
    const evidence: ArchitectureEvidence = { kind: "cycle_path", path: cyclePath(graph, component), source: "transient_source_analysis" };
    const finding: ArchitectureFinding = {
      id: findingId(["dependency_cycle", key]),
      kind: "dependency_cycle",
      status,
      cause: attributeArchitectureCause(graphChanged, policyChanged),
      severity: (targetActive ? policies.target.policy : policies.baseline.policy).cycleSeverity,
      message: "Import dependency cycle detected.",
      evidence: [evidence],
      confidence: "high",
    };
    (status === "introduced" ? introduced : resolved).push(finding);
  }
  return { introduced, resolved };
}

function sortFindings(findings: ArchitectureFinding[]): ArchitectureFinding[] {
  const severity = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((left, right) => severity[left.severity] - severity[right.severity] || left.kind.localeCompare(right.kind) || (left.ruleId ?? "").localeCompare(right.ruleId ?? "") || left.id.localeCompare(right.id));
}

function architectureDiagnostics(delta: CoverageDiagnostics, ambiguities: Set<string>): CoverageDiagnostics {
  return mergeCoverageDiagnostics(delta, createCoverageDiagnostics({ architectureAmbiguities: ambiguities.size, architectureAmbiguityFiles: [...ambiguities].sort() }));
}

function samePolicyPair(policy: ArchitecturePolicy): Pick<ArchitecturePolicyPair, "baseline" | "target"> {
  const source = {
    path: policy.configPath ?? "codeatlas.config.json",
    kind: "absent" as const,
  };
  const snapshot = {
    configured: policy.configured,
    source,
    policy,
    semanticHash: "",
  };
  return { baseline: snapshot, target: snapshot };
}

export function evaluateArchitectureContext(
  context: GraphDeltaContext,
  input: ArchitectureDriftInput,
  policies: Pick<ArchitecturePolicyPair, "baseline" | "target">,
  delta = compareGraphDeltaContext(context, input),
): ArchitectureEvaluation {
  const edges = edgesByKey(context);
  const introduced: ArchitectureFinding[] = [];
  const resolved: ArchitectureFinding[] = [];
  const ambiguityFiles = new Set<string>();
  const inspect = (edge: StructuralEdge, status: "introduced" | "resolved") => {
    const baselineResult = policyViolation(policies.baseline.policy, edge);
    const targetResult = policyViolation(policies.target.policy, edge);
    if (baselineResult.decision.action === "ambiguous" || targetResult.decision.action === "ambiguous") {
      ambiguityFiles.add(edge.from.file);
      ambiguityFiles.add(edge.to.file);
      return;
    }
    const result = status === "introduced" ? targetResult : baselineResult;
    if (!result.violated) return;
    const graphChanged = !edges.before.has(edgeKey(edge, context.renames)) || !edges.after.has(edgeKey(edge));
    const policyChanged = baselineResult.violated !== targetResult.violated;
    (status === "introduced" ? introduced : resolved).push(edgeFinding(edge, result.decision, status, attributeArchitectureCause(graphChanged, policyChanged)));
  };
  for (const key of new Set([...edges.before.keys(), ...edges.after.keys()])) {
    const beforeEdge = edges.before.get(key);
    const afterEdge = edges.after.get(key);
    const representative = afterEdge ?? beforeEdge;
    if (!representative) continue;
    const baselineResult = beforeEdge
      ? policyViolation(policies.baseline.policy, beforeEdge)
      : { violated: false, decision: policyViolation(policies.baseline.policy, representative).decision };
    const targetResult = afterEdge
      ? policyViolation(policies.target.policy, afterEdge)
      : { violated: false, decision: policyViolation(policies.target.policy, representative).decision };
    if (baselineResult.decision.action === "ambiguous" || targetResult.decision.action === "ambiguous") {
      ambiguityFiles.add(representative.from.file);
      ambiguityFiles.add(representative.to.file);
      continue;
    }
    if (!baselineResult.violated && targetResult.violated && afterEdge) inspect(afterEdge, "introduced");
    if (baselineResult.violated && !targetResult.violated && beforeEdge) inspect(beforeEdge, "resolved");
  }
  const cycles = cycleFindings(context, policies);
  const allIntroduced = sortFindings([...introduced, ...cycles.introduced]);
  const allResolved = sortFindings([...resolved, ...cycles.resolved]);
  const diagnostics = architectureDiagnostics(delta.diagnostics, ambiguityFiles);
  const reasons = [...new Set([...delta.reasons, ...diagnostics.reasons])];
  const count = (kind: ArchitectureFinding["kind"]) => allIntroduced.filter((finding) => finding.kind === kind).length;
  const severity = (level: ArchitectureSeverity) => allIntroduced.filter((finding) => finding.severity === level).length;
  return {
    summary: { introduced: allIntroduced.length, resolved: allResolved.length, high: severity("high"), medium: severity("medium"), low: severity("low"), forbiddenDependencies: count("forbidden_dependency"), dependencyCycles: count("dependency_cycle") },
    introduced: allIntroduced,
    resolved: allResolved,
    diagnostics,
    mayBeIncomplete: diagnostics.mayBeIncomplete,
    authoritativeNegativeResults: diagnostics.authoritativeNegativeResults,
    reasons,
  };
}

export function evaluateArchitectureChangeUnderPolicy(
  context: GraphDeltaContext,
  policy: ArchitecturePolicy,
  input: ArchitectureDriftInput = {},
  delta = compareGraphDeltaContext(context, input),
): ArchitectureEvaluation {
  return evaluateArchitectureContext(context, input, samePolicyPair(policy), delta);
}

export async function architectureDrift(repoPath: string, input: ArchitectureDriftInput = {}): Promise<ArchitectureDriftResult> {
  const context = await readGraphDeltaContext(repoPath, input);
  const policies = await loadArchitecturePolicySnapshots(repoPath, context, input.configPath);
  const delta = compareGraphDeltaContext(context, input);
  const evaluation = evaluateArchitectureContext(context, input, policies, delta);
  return {
    source: delta.source,
    policy: {
      configured: policies.target.configured,
      ...(policies.target.policy.configPath ? { configPath: policies.target.policy.configPath } : {}),
      ...(policies.target.policy.version === undefined ? {} : { version: policies.target.policy.version }),
      cyclesEnabled: policies.target.policy.cyclesEnabled,
      baseline: { configured: policies.baseline.configured, path: policies.path, semanticHash: policies.baseline.semanticHash, sourceKind: policies.baseline.source.kind },
      target: { configured: policies.target.configured, path: policies.path, semanticHash: policies.target.semanticHash, sourceKind: policies.target.source.kind },
      fileChanged: policies.fileChanged,
      semanticChanged: policies.semanticChanged,
      changeKind: policies.changeKind,
    },
    ...evaluation,
  };
}

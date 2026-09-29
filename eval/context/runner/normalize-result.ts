import type { TaskContextDelivery } from "../../../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextItem } from "../../../src/core/context/task-context.types.js";
import type { ContextSubject } from "../../../src/core/context/context.types.js";
import type { GateFailure, NormalizedObserved, ObservedCase } from "../types.js";

const temporaryWorkspaceRoot = /(?:\/[^/]+)*\/code-atlas-context-eval-[^/]+/g;
type NonErrorDelivery = Exclude<TaskContextDelivery, { mode: "error" }>;
type SymbolDelivery = NonErrorDelivery & { subject: Extract<ContextSubject, { kind: "symbol" }> };

function normalizeTemporaryPath(value: string): string {
  return value.replace(temporaryWorkspaceRoot, "<workspace>");
}

function normalizeStrings(value: unknown): unknown {
  if (typeof value === "string") return normalizeTemporaryPath(value);
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeStrings(item)]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function semanticSubject(subject: TaskContextItem["subject"], observed: NormalizedObserved, identityInputsEqual: boolean): unknown {
  if (subject.kind === "file" || identityInputsEqual) return subject;
  const deliveryValue = observed.deliveries.find((item): item is SymbolDelivery => item.mode !== "error" && item.subject.kind === "symbol" && item.subject.symbolId === subject.symbolId);
  return {
    kind: "symbol",
    path: subject.path,
    selectorVersion: subject.selectorVersion,
    contentIdentity: deliveryValue?.current.contentIdentity,
  };
}

function selected(items: readonly TaskContextItem[], observed: NormalizedObserved, identityInputsEqual: boolean) {
  return items.map(({ subject, priority, rank }) => ({ subject: semanticSubject(subject, observed, identityInputsEqual), priority, rank }));
}

function delivery(value: TaskContextDelivery, observed: NormalizedObserved, identityInputsEqual: boolean) {
  if (value.mode === "error") return { subject: semanticSubject(value.subject, observed, identityInputsEqual), mode: value.mode, error: value.error };
  return {
    subject: semanticSubject(value.subject, observed, identityInputsEqual),
    mode: value.mode,
    reliability: value.reliability,
    current: value.current,
    ...(value.mode === "full" || value.mode === "rehydrate" ? { content: value.content, ...(value.reason ? { reason: value.reason } : {}) } : {}),
    ...(value.mode === "delta" ? { delta: value.delta } : {}),
  };
}

function reconstructed(value: NormalizedObserved, identityInputsEqual: boolean): unknown {
  if (identityInputsEqual) return value.reconstructedContents;
  const symbolDeliveries = value.deliveries.filter((item): item is SymbolDelivery => item.mode !== "error" && item.subject.kind === "symbol");
  const symbolKeys = new Set(symbolDeliveries.map(({ subject }) => `symbol:${subject.path}:${subject.symbolId}:${subject.selectorVersion}`));
  const files = Object.entries(value.reconstructedContents).filter(([key]) => !symbolKeys.has(key));
  const symbols = symbolDeliveries
    .map(({ subject }) => ({ subject: semanticSubject(subject, value, identityInputsEqual), content: value.reconstructedContents[`symbol:${subject.path}:${subject.symbolId}:${subject.selectorVersion}`] }));
  return { files, symbols };
}

function failure(caseId: string, gate: string, expected: unknown, observed: unknown): GateFailure {
  return { gate, scope: "case", caseId, expected: stable(expected), observed: stable(observed), message: `${gate} differs between equivalent executions` };
}

export function normalizeObserved(value: ObservedCase): NormalizedObserved {
  const { timingsMs: _timingsMs, ...metrics } = value.metrics;
  return {
    ...value,
    reliability: normalizeStrings(value.reliability) as typeof value.reliability,
    reconstructedContents: Object.fromEntries(Object.entries(value.reconstructedContents).map(([key, content]) => [normalizeTemporaryPath(key), content])),
    metrics,
  };
}

export function compareSemanticObserved(left: NormalizedObserved, right: NormalizedObserved, identityInputsEqual: boolean): readonly GateFailure[] {
  const failures: GateFailure[] = [];
  const compare = (gate: string, expected: unknown, observed: unknown) => {
    if (stable(expected) !== stable(observed)) failures.push(failure(left.caseId, gate, expected, observed));
  };
  compare("determinism.case_id", left.caseId, right.caseId);
  compare("determinism.task_identity", left.taskIdentity, right.taskIdentity);
  if (identityInputsEqual) compare("determinism.plan_identity", left.planIdentity, right.planIdentity);
  compare("determinism.selected_items", selected(left.selectedItems, left, identityInputsEqual), selected(right.selectedItems, right, identityInputsEqual));
  compare("determinism.reliability", left.reliability, right.reliability);
  compare("determinism.deliveries", left.deliveries.map((item) => delivery(item, left, identityInputsEqual)), right.deliveries.map((item) => delivery(item, right, identityInputsEqual)));
  compare("determinism.reconstructed_contents", reconstructed(left, identityInputsEqual), reconstructed(right, identityInputsEqual));
  compare("determinism.lifecycle_modes", left.lifecycleModes, right.lifecycleModes);
  compare("determinism.metrics", left.metrics, right.metrics);
  return failures;
}

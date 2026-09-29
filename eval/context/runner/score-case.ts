import { contentIdentity } from "../../../src/core/context/context-snapshot.js";
import { canonicalContextSubjectKey } from "../../../src/core/context/task-context-normalizer.js";
import { compareSemanticObserved, normalizeObserved } from "./normalize-result.js";
import type { ContextSubject } from "../../../src/core/context/context.types.js";
import type { BaselineEntry, CaseScore, DeliveryMode, EvalCase, GateFailure, LifecycleObserved, LifecycleScenario, ObservedCase, ObservedMetrics } from "../types.js";

function failure(caseId: string, gate: string, expected: string | number | boolean, observed: string | number | boolean, message: string): GateFailure {
  return { gate, scope: "case", caseId, expected, observed, message };
}

function subjectKeys(subjects: readonly ContextSubject[]): Set<string> {
  return new Set(subjects.map(canonicalContextSubjectKey));
}

function observedSubjectKeys(subject: ContextSubject): readonly string[] {
  return [
    canonicalContextSubjectKey(subject),
    subject.kind === "file"
      ? `file:${subject.path}`
      : `symbol:${subject.path}:${subject.symbolId}:${subject.selectorVersion}`,
  ];
}

function scoreReconstruction(observed: ObservedCase): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const delivery of observed.deliveries) {
    if (delivery.mode === "error") {
      failures.push(failure(observed.caseId, "reconstruction.delivery_error", true, false, `Delivery failed: ${delivery.error.code}`));
      continue;
    }
    const subjectKey = canonicalContextSubjectKey(delivery.subject);
    const reconstructed = observedSubjectKeys(delivery.subject)
      .map((key) => observed.reconstructedContents[key])
      .find((value) => value !== undefined);
    if (reconstructed === undefined) {
      failures.push(failure(observed.caseId, "reconstruction.subject_key", subjectKey, "absent", "Reconstructed content must be stored under the exact delivered subject key"));
      continue;
    }
    if (contentIdentity(reconstructed) !== delivery.current.contentIdentity) {
      failures.push(failure(observed.caseId, "reconstruction.content_identity", delivery.current.contentIdentity, contentIdentity(reconstructed), "Reconstructed content does not have the delivered content identity"));
    }
    if ((delivery.mode === "full" || delivery.mode === "rehydrate") && reconstructed !== delivery.content) {
      failures.push(failure(observed.caseId, "reconstruction.authoritative_text", delivery.content, false, "Delivered authoritative text is not reconstructed exactly"));
    }
  }
  return failures;
}

function scoreUncertainty(evalCase: EvalCase, observed: ObservedCase): GateFailure[] {
  const failures: GateFailure[] = [];
  if (evalCase.syntheticClass === "incomplete/ambiguity" && !observed.reliability.mayBeIncomplete) {
    failures.push(failure(observed.caseId, "uncertainty.incomplete_preserved", true, false, "Incomplete or ambiguous cases must preserve uncertainty"));
  }
  if ((evalCase.syntheticClass === "incomplete/ambiguity" || observed.reliability.mayBeIncomplete) && !observed.reliability.diagnostics.length) {
    failures.push(failure(observed.caseId, "uncertainty.diagnostics", true, false, "Incomplete reliability must retain diagnostics"));
  }
  return failures;
}

function lifecycleFailure(gate: string, expected: string | number | boolean, observed: string | number | boolean, message: string): GateFailure {
  return { gate, scope: "case", expected, observed, message };
}

export function scoreLifecycle(value: LifecycleObserved, expected: LifecycleScenario): readonly GateFailure[] {
  const failures: GateFailure[] = [];
  const refreshPrimitives = expected.primitives.filter((primitive) => primitive.kind === "refresh");
  const refreshSequences = refreshPrimitives.map((primitive) => primitive.expectedModeSequence);
  if (refreshSequences.every((sequence) => sequence !== undefined)) {
    const expectedModeCounts = new Map<DeliveryMode, number>();
    const observedModeCounts = new Map<DeliveryMode, number>();
    for (const mode of expected.expectedModes) expectedModeCounts.set(mode, (expectedModeCounts.get(mode) ?? 0) + 1);
    for (const mode of value.modes) observedModeCounts.set(mode, (observedModeCounts.get(mode) ?? 0) + 1);
    if (JSON.stringify([...expectedModeCounts.entries()].sort()) !== JSON.stringify([...observedModeCounts.entries()].sort())) {
      failures.push(lifecycleFailure("lifecycle.mode_sequence", expected.expectedModes.join(","), value.modes.join(","), "Lifecycle delivery mode counts must match the declared scenario"));
    }
    let offset = expected.expectedModes.length - refreshSequences.reduce((total, sequence) => total + sequence!.length, 0);
    for (const sequence of refreshSequences) {
      const observed = value.modes.slice(offset, offset + sequence!.length);
      if (JSON.stringify(observed) !== JSON.stringify(sequence)) {
        failures.push(lifecycleFailure("lifecycle.mode_sequence.refresh", sequence.join(","), observed.join(","), "Each lifecycle refresh must match its declared delivery mode sequence"));
      }
      offset += sequence!.length;
    }
  } else if (JSON.stringify(value.modes) !== JSON.stringify(expected.expectedModes)) {
    failures.push(lifecycleFailure("lifecycle.mode_sequence", expected.expectedModes.join(","), value.modes.join(","), "Lifecycle delivery modes must match the declared scenario"));
  }
  if (!value.sessionIds.length || new Set(value.sessionIds).size !== 1) {
    failures.push(lifecycleFailure("lifecycle.session_stability", true, false, "Lifecycle refreshes must preserve one session identity"));
  }
  if (!value.contextGenerations.length || new Set(value.contextGenerations).size !== 1) {
    failures.push(lifecycleFailure("lifecycle.generation_stability", true, false, "Lifecycle refreshes must preserve one context generation"));
  }
  if (!value.crossWorkspaceRefused) {
    failures.push(lifecycleFailure("lifecycle.cross_workspace_refused", true, false, "A lifecycle handle must not resume from another workspace"));
  }
  if (expected.primitives.some((primitive) => primitive.kind === "restart") && !value.restartContinuity) {
    failures.push(lifecycleFailure("lifecycle.restart_continuity", true, false, "Restart must preserve lifecycle session and generation continuity"));
  }
  const expectedBodyResendCount = value.modes.filter((mode) => mode === "full" || mode === "rehydrate").length;
  if (value.bodyResendCount !== expectedBodyResendCount) {
    failures.push(lifecycleFailure("lifecycle.body_resend_count", expectedBodyResendCount, value.bodyResendCount, "Body resend count must equal full and rehydrate deliveries"));
  }
  if (value.modes.length > 0 && Object.keys(value.reconstructedContents).length === 0) {
    failures.push(lifecycleFailure("lifecycle.reconstruction", true, false, "Lifecycle deliveries must produce reconstructed content"));
  }
  for (const [key, content] of Object.entries(value.reconstructedContents)) {
    if ((!key.startsWith("file:") && !key.startsWith("symbol:")) || typeof content !== "string") {
      failures.push(lifecycleFailure("lifecycle.reconstruction", true, false, "Reconstructed content must use canonical subject keys and string content"));
    }
  }
  for (const primitive of expected.primitives) {
    if (primitive.kind !== "mutate") continue;
    for (const [relativePath, content] of Object.entries(primitive.files)) {
      const key = `file:${relativePath}`;
      const observed = value.reconstructedContents[key];
      if (observed === undefined) {
        failures.push(lifecycleFailure("lifecycle.reconstruction", key, "absent", `Reconstructed content is missing for ${relativePath}`));
      } else if (observed !== content) {
        failures.push(lifecycleFailure("lifecycle.reconstruction", content, observed, `Reconstructed content is incorrect for ${relativePath}`));
      }
    }
  }
  if (!value.casLoserWroteNoStrayState) {
    failures.push(lifecycleFailure("lifecycle.cas_loser_state", true, false, "A losing lifecycle CAS must publish no stray receipts or snapshots"));
  }
  return failures;
}

export function scoreCase(input: { evalCase: EvalCase; first: ObservedCase; repeat: ObservedCase; baseline?: BaselineEntry }): CaseScore {
  const { evalCase, first, repeat } = input;
  const failures: GateFailure[] = [];
  const required = subjectKeys(evalCase.truth.requiredSubjects);
  const supporting = subjectKeys(evalCase.truth.supportingSubjects);
  const forbidden = subjectKeys(evalCase.truth.forbiddenRequiredSubjects);
  const selected = first.selectedItems.map((item) => ({ ...item, key: canonicalContextSubjectKey(item.subject) }));
  const selectedKeys = new Set(selected.map((item) => item.key));
  const requiredHits = [...required].filter((key) => selectedKeys.has(key)).length;
  const supportingHits = [...supporting].filter((key) => selectedKeys.has(key)).length;
  const requiredHitRate = required.size === 0 ? 1 : requiredHits / required.size;
  const supportingHitRate = supporting.size === 0 ? 1 : supportingHits / supporting.size;
  const metrics: ObservedMetrics = { ...first.metrics, requiredHitRate, supportingHitRate };

  if (requiredHitRate !== 1) {
    failures.push(failure(first.caseId, "correctness.required_hit_rate", 1, requiredHitRate, "Every required subject must be selected"));
  }

  const falseRequired = selected.filter((item) => item.priority === "required" && !required.has(item.key));
  if (falseRequired.length) {
    failures.push(failure(first.caseId, "authority.false_required", 0, falseRequired.length, "Only reviewed required subjects may be promoted to required"));
  }

  const demotedRequired = selected.filter((item) => item.priority !== "required" && required.has(item.key));
  if (demotedRequired.length) {
    failures.push(failure(first.caseId, "authority.required_priority", 0, demotedRequired.length, "Reviewed required subjects must retain required priority"));
  }

  const forbiddenRequired = selected.filter((item) => item.priority === "required" && forbidden.has(item.key));
  if (forbiddenRequired.length) {
    failures.push(failure(first.caseId, "authority.forbidden_required", 0, forbiddenRequired.length, "Forbidden subjects must not be promoted to required"));
  }

  failures.push(...scoreUncertainty(evalCase, first));
  failures.push(...scoreReconstruction(first));
  const identityInputsEqual = first.repositoryIdentity === repeat.repositoryIdentity && first.workspaceIdentity === repeat.workspaceIdentity;
  failures.push(...compareSemanticObserved(normalizeObserved(first), normalizeObserved(repeat), identityInputsEqual).filter((item) => item.gate !== "determinism.lifecycle_modes"));

  return {
    caseId: first.caseId,
    metrics,
    failures,
    gates: {
      correctness: !failures.some((item) => item.gate.startsWith("correctness.") || item.gate.startsWith("authority.")),
      determinism: !failures.some((item) => item.gate.startsWith("determinism.")),
      reconstruction: !failures.some((item) => item.gate.startsWith("reconstruction.")),
      authorityUncertainty: !failures.some((item) => item.gate.startsWith("authority.") || item.gate.startsWith("uncertainty.")),
      isolation: "unknown",
      catastrophicQuality: true,
    },
  };
}

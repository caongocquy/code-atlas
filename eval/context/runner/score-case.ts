import { contentIdentity } from "../../../src/core/context/context-snapshot.js";
import { canonicalContextSubjectKey } from "../../../src/core/context/task-context-normalizer.js";
import { scoreQuality } from "./aggregate.js";
import { compareSemanticObserved, normalizeObserved } from "./normalize-result.js";
import type { ContextSubject } from "../../../src/core/context/context.types.js";
import type { BaselineEntry, CaseScore, EvalCase, GateFailure, ObservedCase, ObservedMetrics, QualityPolicy } from "../types.js";

function failure(caseId: string, gate: string, expected: string | number | boolean, observed: string | number | boolean, message: string): GateFailure {
  return { gate, scope: "case", caseId, expected, observed, message };
}

function subjectKeys(subjects: readonly ContextSubject[]): Set<string> {
  return new Set(subjects.map(canonicalContextSubjectKey));
}

function scoreReconstruction(observed: ObservedCase): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const delivery of observed.deliveries) {
    if (delivery.mode === "error") {
      failures.push(failure(observed.caseId, "reconstruction.delivery_error", true, false, `Delivery failed: ${delivery.error.code}`));
      continue;
    }
    const subjectKey = canonicalContextSubjectKey(delivery.subject);
    const reconstructed = observed.reconstructedContents[subjectKey];
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

export function scoreCase(input: { evalCase: EvalCase; first: ObservedCase; repeat: ObservedCase; baseline?: BaselineEntry; policy?: QualityPolicy }): CaseScore {
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
  if (input.baseline && input.policy) failures.push(...scoreQuality({ metrics, baseline: input.baseline, policy: input.policy }));

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
      catastrophicQuality: !failures.some((item) => item.gate.startsWith("quality.catastrophic.")),
    },
  };
}

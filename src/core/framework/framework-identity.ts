import type {
  FrameworkAcceptedOutput,
  FrameworkClassification,
  FrameworkEntityRef,
  FrameworkEvidenceRef,
  FrameworkId,
  FrameworkProvenance,
  FrameworkRelationKind,
  FrameworkSubjectRef,
} from "./framework.types.js";
import type { SourceRangeFact } from "../facts/facts.types.js";

const FRAMEWORK_IDS: readonly FrameworkId[] = ["react", "next", "nestjs", "spring", "flutter"];
const MAX_PROVENANCE_ITEMS = 32;
const MAX_PROVENANCE_STRING_LENGTH = 256;
const MAX_EVIDENCE_PATH_LENGTH = 1024;
const MAX_SOURCE_RANGE_SERIALIZED_LENGTH = 128;
const MAX_EVIDENCE_REF_SERIALIZED_LENGTH = 2048;
const MAX_PROVENANCE_SERIALIZED_LENGTH = 128 * 1024;
const RELATION_KINDS: readonly FrameworkRelationKind[] = [
  "component_usage",
  "route_binding",
  "layout_binding",
  "controller_route",
  "module_provider",
  "dependency_injection",
  "bean_relationship",
  "widget_composition",
  "navigation_binding",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isRepositoryRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value, MAX_EVIDENCE_PATH_LENGTH)) return false;
  return !value.includes("\\")
    && !value.startsWith("/")
    && !/^[A-Za-z]:\//.test(value)
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isCanonicalRoutePath(value: unknown, framework: FrameworkId): value is string {
  return isNonEmptyString(value)
    && (framework === "flutter" || (!value.includes("\\") && !value.includes("//") && value.split("/").every((segment) => segment !== "." && segment !== "..")));
}

function isCanonicalRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value, MAX_EVIDENCE_PATH_LENGTH)) return false;
  if (value.replaceAll("\\", "/") !== value || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;

  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function serializedWithinLimit(value: unknown, maxLength: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.length <= maxLength;
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCanonicalLogicalKey(value: unknown, framework: FrameworkId): value is string {
  if (!isNonEmptyString(value)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return false;
  }

  if (!Array.isArray(parsed) || parsed.length !== 6) return false;
  const [scope, router, path, method, conditions, owner] = parsed;
  if (!isCanonicalRelativePath(scope)
    || !isCanonicalRelativePath(router)
    || !isCanonicalRoutePath(path, framework)
    || !(method === null || isNonEmptyString(method))
    || !Array.isArray(conditions)
    || !conditions.every((item) => typeof item === "string")
    || !(owner === null || isNonEmptyString(owner))) {
    return false;
  }

  const sortedConditions = [...conditions].sort();
  return conditions.every((condition, index) => condition === sortedConditions[index])
    && new Set(conditions).size === conditions.length
    && JSON.stringify(parsed) === value;
}

function isFrameworkEntityRef(value: unknown): value is FrameworkEntityRef {
  return isRecord(value)
    && hasOnlyKeys(value, ["framework", "kind", "logicalKey"])
    && FRAMEWORK_IDS.includes(value.framework as FrameworkId)
    && (value.kind === "route" || value.kind === "layout")
    && isCanonicalLogicalKey(value.logicalKey, value.framework as FrameworkId);
}

function isSubjectRef(value: unknown): value is FrameworkSubjectRef {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
  if (value.kind === "language") {
    return hasOnlyKeys(value, ["kind", "nodeId"]) && isNonEmptyString(value.nodeId);
  }
  return value.kind === "framework"
    && hasOnlyKeys(value, ["kind", "entity"])
    && isFrameworkEntityRef(value.entity);
}

function isSourceRange(value: unknown): value is SourceRangeFact {
  const startLine = isRecord(value) ? value.startLine : undefined;
  const endLine = isRecord(value) ? value.endLine : undefined;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["startLine", "endLine", "startColumn", "endColumn"])
    || !isNonNegativeInteger(startLine)
    || !isNonNegativeInteger(endLine)
    || startLine < 1
    || endLine < startLine) {
    return false;
  }

  if (!serializedWithinLimit(value, MAX_SOURCE_RANGE_SERIALIZED_LENGTH)) return false;

  const startColumn = value.startColumn;
  const endColumn = value.endColumn;
  if ((startColumn !== undefined && !isNonNegativeInteger(startColumn))
    || (endColumn !== undefined && !isNonNegativeInteger(endColumn))) {
    return false;
  }

  return startLine !== endLine
    || startColumn === undefined
    || endColumn === undefined
    || endColumn >= startColumn;
}

function isEvidenceRef(value: unknown): value is FrameworkEvidenceRef {
  return isRecord(value)
    && hasOnlyKeys(value, ["relativePath", "inputKey", "localId", "range"])
    && isRepositoryRelativePath(value.relativePath)
    && isNonEmptyString(value.inputKey, MAX_PROVENANCE_STRING_LENGTH)
    && (value.localId === undefined || isNonEmptyString(value.localId, MAX_PROVENANCE_STRING_LENGTH))
    && (value.range === undefined || isSourceRange(value.range))
    && serializedWithinLimit(value, MAX_EVIDENCE_REF_SERIALIZED_LENGTH);
}

function evidenceRefKey(ref: FrameworkEvidenceRef): string {
  const range = ref.range;
  return JSON.stringify([
    ref.relativePath,
    ref.inputKey,
    ref.localId ?? null,
    range === undefined ? null : [range.startLine, range.endLine, range.startColumn ?? null, range.endColumn ?? null],
  ]);
}

function isProvenance(value: unknown): value is FrameworkProvenance {
  return isRecord(value)
    && hasOnlyKeys(value, ["origin", "framework", "capability", "adapterId", "adapterVersion", "strategy", "confidence", "evidenceIds", "refs"])
    && value.origin === "framework_inferred"
    && FRAMEWORK_IDS.includes(value.framework as FrameworkId)
    && (value.capability === undefined || isNonEmptyString(value.capability, MAX_PROVENANCE_STRING_LENGTH))
    && isNonEmptyString(value.adapterId, MAX_PROVENANCE_STRING_LENGTH)
    && isNonEmptyString(value.adapterVersion, MAX_PROVENANCE_STRING_LENGTH)
    && isNonEmptyString(value.strategy, MAX_PROVENANCE_STRING_LENGTH)
    && (value.confidence === "exact" || value.confidence === "strong")
    && Array.isArray(value.evidenceIds)
    && value.evidenceIds.length > 0
    && value.evidenceIds.length <= MAX_PROVENANCE_ITEMS
    && value.evidenceIds.every((id) => isNonEmptyString(id, MAX_PROVENANCE_STRING_LENGTH))
    && new Set(value.evidenceIds).size === value.evidenceIds.length
    && Array.isArray(value.refs)
    && value.refs.length > 0
    && value.refs.length <= MAX_PROVENANCE_ITEMS
    && value.refs.every(isEvidenceRef)
    && new Set(value.refs.map((ref) => evidenceRefKey(ref))).size === value.refs.length
    && serializedWithinLimit(value.evidenceIds, MAX_PROVENANCE_SERIALIZED_LENGTH)
    && serializedWithinLimit(value.refs, MAX_PROVENANCE_SERIALIZED_LENGTH);
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

export function frameworkEntityKey(ref: FrameworkEntityRef): string {
  if (!isFrameworkEntityRef(ref)) throw new TypeError("Invalid framework entity reference");
  return JSON.stringify([ref.framework, ref.kind, ref.logicalKey]);
}

export function frameworkSubjectKey(ref: FrameworkSubjectRef): string {
  if (!isSubjectRef(ref)) throw new TypeError("Invalid framework subject reference");
  return ref.kind === "language"
    ? JSON.stringify(["language", ref.nodeId])
    : JSON.stringify(["framework", ref.entity.framework, ref.entity.kind, ref.entity.logicalKey]);
}

export function decodeFrameworkAcceptedOutput(payload: unknown): FrameworkAcceptedOutput | undefined {
  const value = parsePayload(payload);
  if (!isRecord(value) || !isProvenance(value.provenance)) return undefined;

  if (value.outputKind === "relationship") {
    return hasOnlyKeys(value, ["outputKind", "source", "target", "relationKind", "provenance"])
      && isSubjectRef(value.source)
      && isSubjectRef(value.target)
      && RELATION_KINDS.includes(value.relationKind as FrameworkRelationKind)
      ? value as unknown as FrameworkAcceptedOutput
      : undefined;
  }

  if (value.outputKind === "classification") {
    return hasOnlyKeys(value, ["outputKind", "subject", "classificationKind", "classificationValue", "provenance"])
      && !Object.prototype.hasOwnProperty.call(value, "target")
      && isSubjectRef(value.subject)
      && value.classificationKind === "execution_boundary"
      && (value.classificationValue === "client" || value.classificationValue === "server")
      ? value as unknown as FrameworkClassification
      : undefined;
  }

  return undefined;
}

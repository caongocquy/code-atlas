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

const FRAMEWORK_IDS: readonly FrameworkId[] = ["react", "next", "nestjs", "spring", "flutter"];
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRepositoryRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function isFrameworkEntityRef(value: unknown): value is FrameworkEntityRef {
  return isRecord(value)
    && FRAMEWORK_IDS.includes(value.framework as FrameworkId)
    && (value.kind === "route" || value.kind === "layout")
    && isNonEmptyString(value.logicalKey);
}

function isSubjectRef(value: unknown): value is FrameworkSubjectRef {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
  if (value.kind === "language") return isNonEmptyString(value.nodeId);
  return value.kind === "framework" && isFrameworkEntityRef(value.entity);
}

function isEvidenceRef(value: unknown): value is FrameworkEvidenceRef {
  return isRecord(value)
    && isRepositoryRelativePath(value.relativePath)
    && isNonEmptyString(value.inputKey)
    && (value.localId === undefined || isNonEmptyString(value.localId))
    && (value.range === undefined || isRecord(value.range));
}

function isProvenance(value: unknown): value is FrameworkProvenance {
  return isRecord(value)
    && value.origin === "framework_inferred"
    && FRAMEWORK_IDS.includes(value.framework as FrameworkId)
    && isNonEmptyString(value.adapterId)
    && isNonEmptyString(value.adapterVersion)
    && isNonEmptyString(value.strategy)
    && (value.confidence === "exact" || value.confidence === "strong")
    && Array.isArray(value.evidenceIds)
    && value.evidenceIds.every(isNonEmptyString)
    && Array.isArray(value.refs)
    && value.refs.every(isEvidenceRef);
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
    return isSubjectRef(value.source)
      && isSubjectRef(value.target)
      && RELATION_KINDS.includes(value.relationKind as FrameworkRelationKind)
      ? value as unknown as FrameworkAcceptedOutput
      : undefined;
  }

  if (value.outputKind === "classification") {
    return !Object.prototype.hasOwnProperty.call(value, "target")
      && isSubjectRef(value.subject)
      && value.classificationKind === "execution_boundary"
      && (value.classificationValue === "client" || value.classificationValue === "server")
      ? value as unknown as FrameworkClassification
      : undefined;
  }

  return undefined;
}

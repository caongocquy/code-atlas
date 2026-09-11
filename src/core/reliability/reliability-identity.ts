import type {
  ReliabilityOutputDescriptor,
  ReliabilityOwnerInput,
  ReliabilityScope,
  ReliabilityScopeInput,
} from "./reliability.types.js";

function canonicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new TypeError("Reliability path must be repository-relative and canonical");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("Reliability path must be repository-relative and canonical");
  }
  return segments.join("/");
}

function canonicalOptional(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.includes("\0")) throw new TypeError(`${name} must be non-empty and bounded`);
  return value;
}

export function canonicalReliabilityScope(input: ReliabilityScopeInput): ReliabilityScope {
  if (!input.capability || input.capability.includes("\0")) throw new TypeError("Reliability scope capability is required");
  const normalized = {
    capability: input.capability,
    outputKind: canonicalOptional(input.outputKind, "outputKind"),
    framework: canonicalOptional(input.framework, "framework"),
    language: canonicalOptional(input.language, "language"),
    selectorKey: canonicalOptional(input.selectorKey, "selectorKey"),
  };
  const scopeKey = JSON.stringify([
    normalized.capability,
    normalized.outputKind ?? null,
    normalized.framework ?? null,
    normalized.language ?? null,
    normalized.selectorKey ?? null,
  ]);
  return { ...normalized, scopeKey };
}

export function reliabilityScopeKey(scope: ReliabilityScope): string {
  return scope.scopeKey;
}

export function reliabilityOwnerKey(owner: ReliabilityOwnerInput): string {
  return JSON.stringify([
    owner.sourcePath === undefined ? null : canonicalPath(owner.sourcePath),
    owner.inputKey,
    owner.capability ?? null,
    owner.adapterId ?? null,
  ]);
}

export function reliabilityOutputKey(output: ReliabilityOutputDescriptor): string {
  switch (output.kind) {
    case "entity":
      return JSON.stringify(["entity", output.entityKey]);
    case "relationship":
      return JSON.stringify(["relationship", output.sourceKey, output.targetKey, output.relationKind]);
    case "classification":
      return JSON.stringify(["classification", output.subject.kind, output.subject.nodeId ?? output.subject.entityKey ?? null, output.classificationKind]);
    case "diagnostic":
      return JSON.stringify(["diagnostic", output.code, output.evidenceKey]);
  }
}

export { canonicalPath };

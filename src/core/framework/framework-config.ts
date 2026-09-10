import path from "node:path";

import type {
  FrameworkConfigFact,
  FrameworkConfigValue,
} from "./framework.types.js";

export interface FrameworkConfigInput {
  relativePath: string;
  contentHash: string;
  kind: FrameworkConfigFact["kind"];
  objectiveValues: Readonly<Record<string, FrameworkConfigValue>>;
  complete: boolean;
}

function cloneValue(value: FrameworkConfigValue): FrameworkConfigValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, FrameworkConfigValue>>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, cloneValue(record[key]!)]),
    );
  }
  return value;
}

function cloneValues(
  values: Readonly<Record<string, FrameworkConfigValue>>,
): Readonly<Record<string, FrameworkConfigValue>> {
  return cloneValue(values) as Readonly<Record<string, FrameworkConfigValue>>;
}

function scopeFor(relativePath: string): string {
  const directory = path.posix.dirname(relativePath.replaceAll("\\", "/"));
  return directory === "." ? "" : directory;
}

function inputKey(input: FrameworkConfigInput): string {
  return `${input.kind}:${input.relativePath}:${input.contentHash}`;
}

export function materializeFrameworkConfig(
  inputs: readonly FrameworkConfigInput[],
): readonly FrameworkConfigFact[] {
  return [...inputs]
    .filter((input) => input.relativePath.length > 0 && input.contentHash.length > 0)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath)
      || left.kind.localeCompare(right.kind)
      || left.contentHash.localeCompare(right.contentHash))
    .map((input) => ({
      relativePath: input.relativePath.replaceAll("\\", "/"),
      scope: scopeFor(input.relativePath),
      inputKey: inputKey(input),
      kind: input.kind,
      values: cloneValues(input.objectiveValues),
      complete: input.complete,
    }));
}

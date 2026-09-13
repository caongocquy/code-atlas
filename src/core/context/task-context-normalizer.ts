import { createHash } from "node:crypto";

import { validateContextSubject } from "./context-identity.js";
import type { ContextSubject } from "./context.types.js";
import type { CompileTaskContextInput, NormalizedTaskContextInput, TaskContextAnchor } from "./task-context.types.js";

const TASK_IDENTITY_SCHEMA_VERSION = 1;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizePath(value: string): string {
  const normalized = value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("path must be repository-relative");
  }
  return normalized;
}

function normalizeAnchor(anchor: TaskContextAnchor): TaskContextAnchor {
  if (anchor.kind === "file") return { kind: "file", path: normalizePath(anchor.path) };
  if (anchor.kind === "symbol") {
    if (!anchor.name.trim()) throw new TypeError("symbol name is required");
    return { kind: "symbol", ...(anchor.path === undefined ? {} : { path: normalizePath(anchor.path) }), name: anchor.name.normalize("NFC") };
  }
  throw new TypeError("unsupported anchor");
}

export function normalizeTaskContextInput(input: CompileTaskContextInput): NormalizedTaskContextInput {
  if (typeof input.task !== "string") throw new TypeError("task is required");
  const task = input.task.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim().replace(/[ \t]+/g, " ")).join("\n").trim();
  if (!task) throw new TypeError("task is required");
  const anchors = [...(input.anchors ?? [])].map(normalizeAnchor).sort((a, b) => `${a.kind}:${a.path ?? ""}:${a.name ?? ""}`.localeCompare(`${b.kind}:${b.path ?? ""}:${b.name ?? ""}`));
  const uniqueAnchors = anchors.filter((anchor, index) => index === 0 || stableJson(anchor) !== stableJson(anchors[index - 1]));
  const changedPaths = [...new Set((input.changedPaths ?? []).map(normalizePath))].sort();
  return { task, anchors: uniqueAnchors, changedPaths };
}

export function createTaskIdentity(normalized: NormalizedTaskContextInput): string {
  const payload = { schemaVersion: TASK_IDENTITY_SCHEMA_VERSION, task: normalized.task, anchors: normalized.anchors, changedPaths: normalized.changedPaths };
  return `task-v1:${createHash("sha256").update(stableJson(payload), "utf8").digest("hex")}`;
}

export function canonicalContextSubjectKey(subject: ContextSubject): string {
  const validated = validateContextSubject(subject);
  const payload = validated.kind === "file"
    ? { kind: validated.kind, path: validated.path }
    : { kind: validated.kind, path: validated.path, symbolId: validated.symbolId, selectorVersion: validated.selectorVersion };
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

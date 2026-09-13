import { createHash } from "node:crypto";

import { normalizeTaskContextInput } from "./task-context-normalizer.js";
import type { TaskContextAnchor } from "./task-context.types.js";
import type { TaskContextLifecycleBudget } from "./task-context-lifecycle.types.js";
import { DEFAULT_TASK_CONTEXT_BUDGET, resolveTaskContextBudget } from "./task-context-budget.js";

const DEFAULT_LIFECYCLE_TTL_SECONDS = 86_400;
const MAX_LIFECYCLE_TTL_SECONDS = 2_592_000;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createTaskIntentIdentity(task: string, anchors: readonly TaskContextAnchor[]): string {
  const normalized = normalizeTaskContextInput({ task, anchors: [...anchors] });
  const payload = { schemaVersion: 1, task: normalized.task, anchors: normalized.anchors };
  return `task-intent-v1:${createHash("sha256").update(stableJson(payload), "utf8").digest("hex")}`;
}

export function normalizeLifecycleTtlSeconds(value: number | undefined): number {
  const ttl = value ?? DEFAULT_LIFECYCLE_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_LIFECYCLE_TTL_SECONDS) throw new TypeError("TTL must be a positive integer no greater than 2592000 seconds");
  return ttl;
}

export function normalizeLifecycleBudget(value: { maxItems?: number; maxEstimatedTokens?: number } | undefined): TaskContextLifecycleBudget {
  return resolveTaskContextBudget(value);
}

export function validateTaskContextId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError("taskContextId must be a UUID");
  }
  return value;
}

export { DEFAULT_TASK_CONTEXT_BUDGET };

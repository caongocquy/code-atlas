import { createHash } from "node:crypto";

import type { DeliveredSnapshot } from "./context.types.js";

export function contentIdentity(content: string): string {
  if (typeof content !== "string") throw new TypeError("content is required");
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function createDeliveredSnapshot(
  value: Omit<DeliveredSnapshot, "content" | "contentIdentity" | "createdAt" | "schemaVersion">,
  content: string,
): DeliveredSnapshot {
  if (typeof content !== "string") throw new TypeError("content is required");
  return { ...value, content, contentIdentity: contentIdentity(content), createdAt: new Date().toISOString(), schemaVersion: 1 };
}

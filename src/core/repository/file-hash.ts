import { createHash } from "node:crypto";

export function createFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

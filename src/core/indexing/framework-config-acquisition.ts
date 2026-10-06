import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { parse, parseTree, type Node, type ParseError } from "jsonc-parser";
import type { FrameworkConfigInput } from "../framework/framework-config.js";
import type { FrameworkConfigValue } from "../framework/framework.types.js";

// Match the existing per-record storage ceiling, before allocating a parse tree.
export const MAX_CONFIG_BYTES = 256 * 1024;
export class ConfigAcquisitionError extends Error {
  constructor(readonly code: "config_invalid_json" | "config_duplicate_key" | "config_changed" | "config_too_large" | "config_invalid_structure", relativePath: string) {
    super(code + ": " + relativePath);
    this.name = "ConfigAcquisitionError";
  }
}
export type ConfigByteReader = (relativePath: string) => Promise<Buffer>;

export async function readConfigBytes(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_CONFIG_BYTES)) throw new ConfigAcquisitionError("config_too_large", filePath);
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new ConfigAcquisitionError("config_too_large", filePath);
    const after = await handle.stat({ bigint: true });
    const current = await fs.stat(filePath, { bigint: true });
    const same = (stat: typeof before) => stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    if (!same(after) || !same(current) || BigInt(length) !== before.size) throw new ConfigAcquisitionError("config_changed", filePath);
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

function parseConfig(bytes: Buffer, kind: FrameworkConfigInput["kind"], relativePath: string): FrameworkConfigInput["objectiveValues"] {
  if (bytes.length > MAX_CONFIG_BYTES) throw new ConfigAcquisitionError("config_too_large", relativePath);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ConfigAcquisitionError("config_invalid_json", relativePath); }
  const errors: ParseError[] = [];
  let values: unknown;
  try {
    if (kind === "package") {
      // JSON.parse enforces JSON syntax; the tree independently checks decoded key uniqueness.
      values = JSON.parse(source) as unknown;
      const tree = parseTree(source, errors, { disallowComments: true, allowTrailingComma: false });
      if (!tree || errors.length) throw new ConfigAcquisitionError("config_invalid_json", relativePath);
      const pending: Array<{ node: Node; depth: number }> = [{ node: tree, depth: 0 }];
      while (pending.length) {
        const { node, depth } = pending.pop()!;
        if (depth > 16) throw new ConfigAcquisitionError("config_invalid_structure", relativePath);
        if (node.type === "object") {
          const keys = new Set<string>();
          for (const property of node.children ?? []) {
            const key = property.children![0]!.value as string;
            if (keys.has(key)) throw new ConfigAcquisitionError("config_duplicate_key", relativePath);
            keys.add(key);
            pending.push({ node: property.children![1]!, depth: depth + 1 });
          }
        } else if (node.type === "array") {
          for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
        }
      }
    } else {
      values = parse(source, errors, { allowTrailingComma: true }) as unknown;
      if (errors.length) throw new ConfigAcquisitionError("config_invalid_json", relativePath);
    }
  } catch (error) {
    if (error instanceof ConfigAcquisitionError) throw error;
    throw new ConfigAcquisitionError(error instanceof RangeError ? "config_invalid_structure" : "config_invalid_json", relativePath);
  }
  if (values === null || typeof values !== "object" || Array.isArray(values)) throw new ConfigAcquisitionError("config_invalid_structure", relativePath);
  const pending: Array<{ value: unknown; depth: number }> = [{ value: values, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 16 || (typeof value === "number" && !Number.isFinite(value))) throw new ConfigAcquisitionError("config_invalid_structure", relativePath);
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return values as Readonly<Record<string, FrameworkConfigValue>>;
}

export async function acquireFrameworkConfig(
  repoPath: string, relativePath: string, kind: FrameworkConfigInput["kind"], expectedHash: string,
  reader: ConfigByteReader = file => readConfigBytes(path.join(repoPath, file)),
): Promise<FrameworkConfigInput> {
  if (relativePath.length + kind.length + expectedHash.length + 2 > 4096 || path.isAbsolute(relativePath)
    || relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ConfigAcquisitionError("config_invalid_structure", relativePath);
  }
  const supported = kind === "package" || kind === "tsconfig" || kind === "jsconfig";
  if (!supported) return { relativePath, kind, contentHash: expectedHash, objectiveValues: {}, complete: false };
  const before = await reader(relativePath);
  if (before.length > MAX_CONFIG_BYTES) throw new ConfigAcquisitionError("config_too_large", relativePath);
  const contentHash = createHash("sha256").update(before).digest("hex");
  if (contentHash !== expectedHash) throw new ConfigAcquisitionError("config_changed", relativePath);
  const objectiveValues = parseConfig(before, kind, relativePath);
  const after = await reader(relativePath);
  if (after.length > MAX_CONFIG_BYTES) throw new ConfigAcquisitionError("config_too_large", relativePath);
  if (!before.equals(after)) throw new ConfigAcquisitionError("config_changed", relativePath);
  return { relativePath, kind, contentHash, objectiveValues, complete: supported };
}

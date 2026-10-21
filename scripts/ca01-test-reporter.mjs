import path from "node:path";
import process from "node:process";

function plain(value, seen = new Set()) {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: String(value) };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Date) return { $type: "Date", value: value.toISOString() };
  if (value instanceof RegExp) return { $type: "RegExp", source: value.source, flags: value.flags };
  if (value instanceof Map) return { $type: "Map", entries: [...value].map(item => plain(item, new Set(seen))) };
  if (value instanceof Set) return { $type: "Set", values: [...value].map(item => plain(item, new Set(seen))) };
  if (Array.isArray(value)) return value.map(item => plain(item, new Set(seen)));
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, plain(value[key], new Set(seen))]));
}

export function hasUsableFailureEvidence(error) {
  return error !== null && typeof error === "object" && !Array.isArray(error)
    && !("$type" in error)
    && [error.message, error.stack].some(value => typeof value === "string" && value.trim().length > 0);
}

export default async function* report(events) {
  for await (const { type, data } of events) {
    if (type === "test:pass" || type === "test:fail") {
      if (type === "test:fail" && !hasUsableFailureEvidence(data.details?.error)) {
        throw new Error(`Missing usable error evidence: ${data.file}:${data.name}`);
      }
      yield JSON.stringify({ type, identity: { file: data.file ? path.relative(process.cwd(), data.file).replaceAll("\\", "/") : null,
        line: data.line ?? null, column: data.column ?? null, nesting: data.nesting, name: data.name },
        skip: data.skip ?? false, todo: data.todo ?? false, error: plain(data.details?.error) }) + "\n";
    } else if (type === "test:diagnostic" && data.nesting === 0) {
      yield JSON.stringify({ type, message: data.message }) + "\n";
    }
  }
}

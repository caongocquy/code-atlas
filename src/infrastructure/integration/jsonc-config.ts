import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import {
  readConfigFile,
  type ConfigFile,
  ConfigParseError,
  writeConfigFile,
} from "./config-file.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsoncConfig(configPath: string): Promise<{ file: ConfigFile; value: JsonObject }> {
  const file = await readConfigFile(configPath);
  if (!file.exists || file.text.trim() === "") return { file, value: {} };

  const errors: ParseError[] = [];
  const value = parse(file.text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new ConfigParseError(file.path, `JSONC parse error code ${errors[0]?.error ?? "unknown"}`);
  }
  if (!isJsonObject(value)) throw new ConfigParseError(file.path, "root value must be an object");
  return { file, value };
}

export async function writeJsoncValue(
  configPath: string,
  jsonPath: string[],
  value: unknown,
): Promise<boolean> {
  const current = await readJsoncConfig(configPath);
  const parentPath = jsonPath.slice(0, -1);
  const key = jsonPath.at(-1);
  if (!key) throw new Error("JSON config path must not be empty");
  let parent: unknown = current.value;
  for (const segment of parentPath) {
    if (!isJsonObject(parent)) break;
    parent = parent[segment];
  }
  const existing = isJsonObject(parent) ? parent[key] : undefined;
  if (JSON.stringify(existing) === JSON.stringify(value)) return false;

  const source = current.file.exists && current.file.text.trim() !== "" ? current.file.text : "{}\n";
  const edits = modify(source, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const updated = applyEdits(source, edits);
  await readJsoncText(current.file.path, updated);
  await writeConfigFile({ ...current.file, text: source }, updated);
  return true;
}

export async function removeJsoncValue(configPath: string, jsonPath: string[]): Promise<boolean> {
  const current = await readJsoncConfig(configPath);
  let parent: unknown = current.value;
  for (const segment of jsonPath.slice(0, -1)) {
    if (!isJsonObject(parent)) return false;
    parent = parent[segment];
  }
  const key = jsonPath.at(-1);
  if (!key || !isJsonObject(parent) || !(key in parent)) return false;

  const edits = modify(current.file.text, jsonPath, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const updated = applyEdits(current.file.text, edits);
  await readJsoncText(current.file.path, updated);
  await writeConfigFile(current.file, updated);
  return true;
}

async function readJsoncText(configPath: string, text: string): Promise<void> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isJsonObject(value)) {
    throw new ConfigParseError(configPath, "generated JSONC value is invalid");
  }
}

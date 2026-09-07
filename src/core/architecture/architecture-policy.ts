import fs from "node:fs/promises";
import path from "node:path";

import type { StructuralEdge } from "../change/graph-delta.types.js";
import { parseCodeAtlasRepositoryConfig } from "../config/codeatlas-config.js";

export type ArchitectureEdgeKind = "imports" | "calls";
export type ArchitectureAction = "allow" | "deny";
export type ArchitectureSeverity = "low" | "medium" | "high";

export type ArchitectureGroup = {
  id: string;
  include: string[];
  exclude: string[];
};

export type ArchitectureRule = {
  id: string;
  from: string;
  to: string;
  action: ArchitectureAction;
  edgeKinds: ArchitectureEdgeKind[];
  severity: ArchitectureSeverity;
  message?: string;
};

export type ArchitecturePolicy = {
  configured: boolean;
  configPath?: string;
  version?: number;
  groups: ArchitectureGroup[];
  rules: ArchitectureRule[];
  defaultCrossGroupAction: ArchitectureAction;
  requireClassification: boolean;
  cyclesEnabled: boolean;
  cycleSeverity: ArchitectureSeverity;
};

export type ArchitectureMembership =
  | { state: "classified"; groupId: string }
  | { state: "unclassified" }
  | { state: "ambiguous"; groupIds: string[] };

export type ArchitectureEdgeDecision = {
  from: ArchitectureMembership;
  to: ArchitectureMembership;
  action: ArchitectureAction | "unclassified" | "ambiguous";
  rule?: ArchitectureRule;
};

export class ArchitectureConfigError extends Error {}

const ALL_EDGE_KINDS: ArchitectureEdgeKind[] = ["imports", "calls"];
const SEVERITIES = new Set<ArchitectureSeverity>(["low", "medium", "high"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchitectureConfigError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function known(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ArchitectureConfigError(`${label}.${key} is not supported.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ArchitectureConfigError(`${label} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length === 0 && required || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ArchitectureConfigError(`${label} must be a non-empty array of strings.`);
  }
  return value as string[];
}

function normalizePattern(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) throw new ArchitectureConfigError(`${label} must be repository-relative.`);
  if ((normalized.match(/\[/g)?.length ?? 0) !== (normalized.match(/\]/g)?.length ?? 0)) throw new ArchitectureConfigError(`${label} contains an invalid glob pattern.`);
  return normalized;
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matches(file: string, group: ArchitectureGroup): boolean {
  const normalizedFile = file.replaceAll("\\", "/");
  return group.include.some((pattern) => globRegex(pattern).test(normalizedFile))
    && !group.exclude.some((pattern) => globRegex(pattern).test(normalizedFile));
}

function membership(policy: ArchitecturePolicy, file: string): ArchitectureMembership {
  const groupIds = policy.groups.filter((group) => matches(file, group)).map((group) => group.id).sort();
  if (groupIds.length === 0) return { state: "unclassified" };
  if (groupIds.length > 1) return { state: "ambiguous", groupIds };
  return { state: "classified", groupId: groupIds[0]! };
}

export function classifyArchitectureFile(policy: ArchitecturePolicy, file: string): ArchitectureMembership {
  return membership(policy, file);
}

export function evaluateArchitectureEdge(policy: ArchitecturePolicy, edge: StructuralEdge): ArchitectureEdgeDecision {
  const from = membership(policy, edge.from.file);
  const to = membership(policy, edge.to.file);
  if (from.state === "ambiguous" || to.state === "ambiguous") return { from, to, action: "ambiguous" };
  if (from.state !== "classified" || to.state !== "classified") return { from, to, action: "unclassified" };
  const matchesForEdge = policy.rules.filter((rule) => rule.from === from.groupId && rule.to === to.groupId && rule.edgeKinds.includes(edge.kind));
  const rule = matchesForEdge[0];
  if (rule) return { from, to, action: rule.action, rule };
  if (from.groupId === to.groupId) return { from, to, action: "allow" };
  return { from, to, action: policy.defaultCrossGroupAction };
}

function validateRules(groups: ArchitectureGroup[], rawRules: unknown): ArchitectureRule[] {
  if (rawRules === undefined) return [];
  if (!Array.isArray(rawRules)) throw new ArchitectureConfigError("architecture.rules must be an array.");
  const groupIds = new Set(groups.map((group) => group.id));
  const ids = new Set<string>();
  const rules: ArchitectureRule[] = [];
  for (const [index, raw] of rawRules.entries()) {
    const value = object(raw, `architecture.rules[${index}]`);
    known(value, ["id", "from", "to", "action", "edgeKinds", "severity", "message"], `architecture.rules[${index}]`);
    const id = string(value.id, `architecture.rules[${index}].id`);
    if (ids.has(id)) throw new ArchitectureConfigError(`Duplicate architecture rule id: ${id}.`);
    ids.add(id);
    const from = string(value.from, `${id}.from`);
    const to = string(value.to, `${id}.to`);
    if (!groupIds.has(from) || !groupIds.has(to)) throw new ArchitectureConfigError(`Architecture rule ${id} references an unknown group.`);
    const action = value.action;
    if (action !== "allow" && action !== "deny") throw new ArchitectureConfigError(`Architecture rule ${id} has an invalid action.`);
    const edgeKinds = value.edgeKinds === undefined ? [...ALL_EDGE_KINDS] : stringArray(value.edgeKinds, `${id}.edgeKinds`, true) as ArchitectureEdgeKind[];
    if (edgeKinds.some((kind) => !ALL_EDGE_KINDS.includes(kind))) throw new ArchitectureConfigError(`Architecture rule ${id} has an unsupported edge kind.`);
    if (new Set(edgeKinds).size !== edgeKinds.length) throw new ArchitectureConfigError(`Architecture rule ${id} repeats an edge kind.`);
    const severity = value.severity === undefined ? (action === "deny" ? "medium" : "low") : value.severity;
    if (!SEVERITIES.has(severity as ArchitectureSeverity)) throw new ArchitectureConfigError(`Architecture rule ${id} has an invalid severity.`);
    rules.push({ id, from, to, action, edgeKinds, severity: severity as ArchitectureSeverity, ...(value.message === undefined ? {} : { message: string(value.message, `${id}.message`) }) });
  }
  const decisions = new Map<string, ArchitectureAction>();
  for (const rule of rules) for (const edgeKind of rule.edgeKinds) {
    const key = `${rule.from}\0${rule.to}\0${edgeKind}`;
    const previous = decisions.get(key);
    if (previous && previous !== rule.action) throw new ArchitectureConfigError(`Architecture rules conflict for ${rule.from} -> ${rule.to} (${edgeKind}).`);
    decisions.set(key, rule.action);
  }
  return rules;
}

export function defaultArchitecturePolicy(configPath?: string): ArchitecturePolicy {
  return {
    configured: false,
    ...(configPath ? { configPath } : {}),
    groups: [],
    rules: [],
    defaultCrossGroupAction: "allow",
    requireClassification: false,
    cyclesEnabled: true,
    cycleSeverity: "medium",
  };
}

export function parseArchitecturePolicy(raw: unknown, configPath?: string): ArchitecturePolicy {
  let root: ReturnType<typeof parseCodeAtlasRepositoryConfig>;
  try {
    root = parseCodeAtlasRepositoryConfig(raw);
  } catch (error) {
    throw new ArchitectureConfigError(error instanceof Error ? error.message : String(error));
  }
  const architecture = root.architecture ?? {};
  known(architecture, ["groups", "defaultCrossGroupAction", "rules", "requireClassification", "cycles"], "architecture");
  const rawGroups = architecture.groups === undefined ? [] : architecture.groups;
  if (!Array.isArray(rawGroups)) throw new ArchitectureConfigError("architecture.groups must be an array.");
  const ids = new Set<string>();
  const groups: ArchitectureGroup[] = [];
  for (const [index, rawGroup] of rawGroups.entries()) {
    const value = object(rawGroup, `architecture.groups[${index}]`);
    known(value, ["id", "include", "exclude"], `architecture.groups[${index}]`);
    const id = string(value.id, `architecture.groups[${index}].id`);
    if (ids.has(id)) throw new ArchitectureConfigError(`Duplicate architecture group id: ${id}.`);
    ids.add(id);
    groups.push({ id, include: stringArray(value.include, `${id}.include`, true).map((pattern) => normalizePattern(pattern, `${id}.include`)), exclude: stringArray(value.exclude, `${id}.exclude`).map((pattern) => normalizePattern(pattern, `${id}.exclude`)) });
  }
  const defaultCrossGroupAction = architecture.defaultCrossGroupAction === undefined ? "allow" : architecture.defaultCrossGroupAction;
  if (defaultCrossGroupAction !== "allow" && defaultCrossGroupAction !== "deny") throw new ArchitectureConfigError("architecture.defaultCrossGroupAction must be allow or deny.");
  const cycles = architecture.cycles === undefined ? {} : object(architecture.cycles, "architecture.cycles");
  known(cycles, ["enabled", "severity"], "architecture.cycles");
  const cycleSeverity = cycles.severity === undefined ? "medium" : cycles.severity;
  if (!SEVERITIES.has(cycleSeverity as ArchitectureSeverity)) throw new ArchitectureConfigError("architecture.cycles.severity is invalid.");
  if (cycles.enabled !== undefined && typeof cycles.enabled !== "boolean") throw new ArchitectureConfigError("architecture.cycles.enabled must be boolean.");
  if (architecture.requireClassification !== undefined && typeof architecture.requireClassification !== "boolean") throw new ArchitectureConfigError("architecture.requireClassification must be boolean.");
  return {
    configured: true,
    ...(configPath ? { configPath } : {}),
    version: 1,
    groups,
    rules: validateRules(groups, architecture.rules),
    defaultCrossGroupAction,
    requireClassification: architecture.requireClassification === true,
    cyclesEnabled: cycles.enabled !== false,
    cycleSeverity: cycleSeverity as ArchitectureSeverity,
  };
}

export async function loadArchitecturePolicy(repoPath: string, explicitPath?: string): Promise<ArchitecturePolicy> {
  const configPath = path.resolve(repoPath, explicitPath ?? "codeatlas.config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return defaultArchitecturePolicy();
    }
    if (error instanceof SyntaxError) throw new ArchitectureConfigError(`Invalid JSON in ${configPath}.`);
    throw new ArchitectureConfigError(`Unable to read architecture config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseArchitecturePolicy(raw, configPath);
}

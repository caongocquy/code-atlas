import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { SyntaxObservation } from "../facts/objective-syntax.types.js";
import type { FrameworkAnalysisContext, FrameworkDiagnostic, FrameworkEvidence, FrameworkId } from "./framework.types.js";
import { frameworkEnclosingClass, frameworkGraphSymbol, frameworkImportedName } from "./framework-symbol-binding.js";

export type ScheduledTriggerKind = "cron" | "interval" | "timeout" | "fixed_rate" | "fixed_delay";
export type ScheduledSpec = { kind: "cron"; expression: string } | { kind: "duration"; value: number; unit: "milliseconds" };
export type ScheduledModifiers = { timeZone: string | null; utcOffset: number | null; initialDelay: number | null };
// Runtime state is declaration metadata and intentionally does not participate in job identity.
export type ScheduledMetadata = { disabled: boolean; waitForCompletion: boolean };
export type ScheduledIdentity = readonly [scope: string, callableKey: readonly [file: string, typePath: string, method: string], trigger: ScheduledTriggerKind, schedule: ScheduledSpec, declaredName: string | null, modifiers: ScheduledModifiers];
export const SCHEDULE_UNSUPPORTED_REASONS = ["dynamic_schedule", "unsupported_options", "unsupported_numeric", "unsupported_time_unit", "unsupported_decorator_origin", "multiple_decorators", "unsupported_schedule_form", "invalid_schedule"] as const;
export type ScheduledUnsupportedReason = typeof SCHEDULE_UNSUPPORTED_REASONS[number];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && v.trim() === v && !/[\u0000-\u001f]/.test(v);
const relative = (v: unknown): v is string => text(v) && !v.includes("\\") && !v.startsWith("/") && !/^[A-Za-z]:/.test(v) && v.split("/").every((p) => p && p !== "." && p !== "..");
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function isScheduledMetadata(v: unknown): v is ScheduledMetadata { return record(v) && keys(v, ["disabled", "waitForCompletion"]) && typeof v.disabled === "boolean" && typeof v.waitForCompletion === "boolean"; }
export function decodeScheduledIdentity(framework: FrameworkId, value: unknown): ScheduledIdentity | undefined {
  if ((framework !== "nestjs" && framework !== "spring") || typeof value !== "string") return undefined;
  try {
    const p: unknown = JSON.parse(value);
    if (!Array.isArray(p) || p.length !== 6) return undefined;
    const [scope, callable, trigger, spec, name, modifiers] = p;
    if (!relative(scope) || !Array.isArray(callable) || callable.length !== 3 || !relative(callable[0]) || !text(callable[1]) || !text(callable[2])
      || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callable[1]) || !/^[A-Za-z_$][\w$]*$/.test(callable[2])
      || !(framework === "nestjs" ? ["cron", "interval", "timeout"] : ["cron", "fixed_rate", "fixed_delay"]).includes(trigger)
      || !(name === null || text(name)) || (framework === "spring" && name !== null) || !record(spec) || !record(modifiers)
      || !keys(modifiers, ["timeZone", "utcOffset", "initialDelay"])) return undefined;
    const { timeZone, utcOffset, initialDelay } = modifiers;
    if (!(timeZone === null || text(timeZone)) || !(utcOffset === null || (typeof utcOffset === "number" && Number.isSafeInteger(utcOffset) && Math.abs(utcOffset) <= 1440))
      || !(initialDelay === null || integer(initialDelay)) || (timeZone !== null && utcOffset !== null)) return undefined;
    let schedule: ScheduledSpec;
    if (trigger === "cron") {
      if (!keys(spec, ["kind", "expression"]) || spec.kind !== "cron" || !text(spec.expression) || /\$\{|#\{/.test(spec.expression) || initialDelay !== null
        || (framework === "spring" && utcOffset !== null)) return undefined;
      schedule = { kind: "cron", expression: spec.expression };
    } else {
      if (!keys(spec, ["kind", "value", "unit"]) || spec.kind !== "duration" || spec.unit !== "milliseconds" || !integer(spec.value)
        || (trigger !== "timeout" && spec.value === 0) || timeZone !== null || utcOffset !== null || (framework === "nestjs" && initialDelay !== null)) return undefined;
      schedule = { kind: "duration", value: spec.value, unit: "milliseconds" };
    }
    const canonical: ScheduledIdentity = [scope, callable as [string, string, string], trigger as ScheduledTriggerKind, schedule, name, { timeZone: timeZone as string | null, utcOffset: utcOffset as number | null, initialDelay: initialDelay as number | null }];
    return JSON.stringify(canonical) === value ? canonical : undefined;
  } catch { return undefined; }
}
export function isPublishableScheduledDiagnostic(d: FrameworkDiagnostic): boolean {
  return d.code === "framework_schedule_unsupported" && d.outcome === "unsupported" && (d.framework === "nestjs" || d.framework === "spring")
    && d.capability === (d.framework === "nestjs" ? "nestjs.schedule" : "spring.scheduling") && d.strategy === `schedule.${d.reason}`
    && (SCHEDULE_UNSUPPORTED_REASONS as readonly string[]).includes(d.reason);
}
export function isScheduledCoverage(framework: string, capability: string, strategy: string, kind: string): boolean {
  return (framework === "nestjs" || framework === "spring") && capability === (framework === "nestjs" ? "nestjs.schedule" : "spring.scheduling")
    && kind === "scheduled_handler" && SCHEDULE_UNSUPPORTED_REASONS.some((reason) => strategy === `schedule.${reason}`);
}

type ParsedSchedule = { trigger: ScheduledTriggerKind; spec: ScheduledSpec; name: string | null; modifiers: ScheduledModifiers; metadata: ScheduledMetadata };
const emptyModifiers = (): ScheduledModifiers => ({ timeZone: null, utcOffset: null, initialDelay: null });
function parseSchedule(framework: "nestjs" | "spring", decorator: string, annotation: SyntaxObservation, nodes: Map<string, SyntaxObservation>, facts: ParsedFactsBlob): ParsedSchedule | ScheduledUnsupportedReason {
  const args = annotation.arguments.map((a) => ({ name: a.name, node: nodes.get(a.valueId) }));
  const literal = (n: SyntaxObservation | undefined) => n?.kind === "literal" ? n.value : undefined;
  // Objective syntax can collapse unary/binary expressions to their first literal.
  // Join existing expression text for Nest; require adjacent literal attribute ranges
  // ponytail: Spring accepts adjacent literal attributes; wider forms need richer annotation facts.
  if (framework === "nestjs") {
    const call = annotation.children.map((id) => nodes.get(id)).find((n) => n?.kind === "call");
    const expression = facts.expressions.find((e) => e.localId === call?.factId);
    const raw = expression?.text;
    if (!expression || !raw) return "unsupported_schedule_form";
    const offset = (line: number, column: number | undefined) => {
      if (column === undefined) return -1;
      const lines = raw.split("\n");
      const row = line - expression.range.startLine;
      if (row < 0 || row >= lines.length) return -1;
      return lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0) + column - (row === 0 ? expression.range.startColumn ?? 0 : 0);
    };
    let end = raw.indexOf("(") + 1;
    for (let i = 0; i < args.length; i++) {
      const n = args[i]!.node;
      if (!n) return "unsupported_schedule_form";
      const start = offset(n.range.startLine, n.range.startColumn);
      if (raw.slice(end, start).trim() !== (i === 0 ? "" : ",")) return "unsupported_schedule_form";
      end = offset(n.range.endLine, n.range.endColumn);
      if (n.kind === "object") for (const id of n.children) {
        const prop = nodes.get(id);
        const child = prop?.children.length === 1 ? nodes.get(prop.children[0]!) : undefined;
        if (prop && child && child.kind === "literal") {
          const prefix = raw.slice(offset(prop.range.startLine, prop.range.startColumn), offset(child.range.startLine, child.range.startColumn));
          const suffix = raw.slice(offset(child.range.endLine, child.range.endColumn), offset(prop.range.endLine, prop.range.endColumn));
          if (prefix.trim() !== `${prop.name}:` || suffix.trim() !== "") return "unsupported_options";
        }
      }
    }
    if (raw.slice(end).trim() !== ")") return "unsupported_schedule_form";
  } else {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.node?.kind !== "literal") continue;
      const n = arg.node!;
      const label = annotation.children.flatMap((id) => {
        const child = nodes.get(id);
        return child?.kind === "annotation" ? child.children.map((cid) => nodes.get(cid)) : [child];
      }).find((child) => child?.kind === "identifier" && child.name === arg.name);
      const next = args[i + 1];
      const nextLabel = next && [...nodes.values()].find((child) => child.kind === "identifier" && child.name === next.name
        && child.range.startLine >= n.range.endLine && (child.range.startLine > n.range.endLine || (child.range.startColumn ?? -1) > (n.range.endColumn ?? -1)));
      if (!label || label.range.endLine !== n.range.startLine || (label.range.endColumn ?? -1) + 1 !== n.range.startColumn
        || (next ? !nextLabel || n.range.endLine !== nextLabel.range.startLine || !([1, 2].includes((nextLabel.range.startColumn ?? -1) - (n.range.endColumn ?? -1)))
          : n.range.endLine !== annotation.range.endLine || (n.range.endColumn ?? -1) + 1 !== annotation.range.endColumn)) return typeof n.value === "number" ? "unsupported_numeric" : "dynamic_schedule";
    }
  }
  const metadata = { disabled: false, waitForCompletion: false };
  const modifiers = emptyModifiers();
  let trigger: ScheduledTriggerKind;
  let value: unknown;
  let name: string | null = null;
  if (framework === "nestjs") {
    trigger = decorator === "Cron" ? "cron" : decorator === "Interval" ? "interval" : "timeout";
    if (trigger === "cron") {
      if (args.length < 1 || args.length > 2) return "unsupported_schedule_form";
      value = literal(args[0]?.node);
      if (args[1]) {
        const options = args[1].node;
        if (options?.kind !== "object") return "unsupported_options";
        const seen = new Set<string>();
        for (const id of options.children) {
          const prop = nodes.get(id);
          if (prop?.kind !== "property" || !prop.name || seen.has(prop.name) || prop.children.length !== 1) return "unsupported_options";
          seen.add(prop.name);
          const v = literal(nodes.get(prop.children[0]!));
          if (prop.name === "name" && text(v)) name = v;
          else if (prop.name === "timeZone" && text(v)) modifiers.timeZone = v;
          else if (prop.name === "utcOffset" && typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 1440) modifiers.utcOffset = v;
          else if (prop.name === "disabled" && typeof v === "boolean") metadata.disabled = v;
          else if (prop.name === "waitForCompletion" && typeof v === "boolean") metadata.waitForCompletion = v;
          else return "unsupported_options";
        }
        if (modifiers.timeZone !== null && modifiers.utcOffset !== null) return "invalid_schedule";
      }
    } else {
      if (args.length === 1) value = literal(args[0]?.node);
      else if (args.length === 2 && text(literal(args[0]?.node))) { name = literal(args[0]?.node) as string; value = literal(args[1]?.node); }
      else return "unsupported_schedule_form";
    }
  } else {
    const attributes = new Map<string, SyntaxObservation | undefined>();
    for (const a of args) { if (!a.name || attributes.has(a.name)) return "invalid_schedule"; attributes.set(a.name, a.node); }
    if (attributes.has("timeUnit")) return "unsupported_time_unit";
    if ([...attributes.keys()].some((k) => !["cron", "fixedRate", "fixedDelay", "initialDelay", "zone"].includes(k))) return "unsupported_options";
    const periodic = ["cron", "fixedRate", "fixedDelay"].filter((k) => attributes.has(k));
    if (periodic.length !== 1) return "invalid_schedule";
    trigger = periodic[0] === "cron" ? "cron" : periodic[0] === "fixedRate" ? "fixed_rate" : "fixed_delay";
    value = literal(attributes.get(periodic[0]!));
    if (attributes.has("zone")) {
      const zone = literal(attributes.get("zone"));
      if (trigger !== "cron" || (zone !== "" && !text(zone)) || (typeof zone === "string" && /\$\{|#\{/.test(zone))) return "unsupported_options";
      modifiers.timeZone = zone === "" ? null : zone as string;
    }
    if (attributes.has("initialDelay")) {
      const delay = literal(attributes.get("initialDelay"));
      if (trigger === "cron") return "invalid_schedule";
      if (!integer(delay)) return "unsupported_numeric";
      modifiers.initialDelay = delay;
    }
    metadata.disabled = trigger === "cron" && value === "-";
  }
  if (trigger === "cron") {
    if (typeof value !== "string" || /\$\{|#\{/.test(value)) return "dynamic_schedule";
    const expression = value.trim().replace(/\s+/g, " ");
    if (!text(expression)) return "invalid_schedule";
    return { trigger, spec: { kind: "cron", expression }, name, modifiers, metadata };
  }
  if (!integer(value) || (trigger !== "timeout" && value === 0)) return "unsupported_numeric";
  return { trigger, spec: { kind: "duration", value, unit: "milliseconds" }, name, modifiers, metadata };
}
function callableKey(facts: ParsedFactsBlob, file: string, method: string): readonly [string, string, string] | undefined {
  const symbol = facts.symbols.find((s) => s.localId === method && s.kind === "method");
  if (!symbol) return undefined;
  const scopes = new Map(facts.containmentScopes.map((s) => [s.localId, s]));
  const types: string[] = [];
  let id = symbol.scopeId;
  while (id) { const type = facts.symbols.find((s) => s.scopeId === id && (s.kind === "class" || s.kind === "interface")); if (type) types.unshift(type.name); id = scopes.get(id)?.parentId; }
  return types.length ? [file, types.join("."), symbol.name] : undefined;
}
export function collectScheduledEvidence(ctx: FrameworkAnalysisContext, framework: "nestjs" | "spring"): FrameworkEvidence[] {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!ctx.analyzePaths.has(materialized.relativePath)) continue;
    const facts = materialized.facts;
    const syntax = facts.frameworkSyntax;
    if (!syntax) continue;
    const module = framework === "nestjs" ? "@nestjs/schedule" : "org.springframework.scheduling.annotation.Scheduled";
    const names = framework === "nestjs" ? ["Cron", "Interval", "Timeout"] : ["Scheduled"];
    const annotations = syntax.nodes.filter((n) => n.kind === "annotation" && facts.imports.some((i) => i.localName === n.name && i.moduleSpecifier === module && (i.kind === "namespace" || names.includes(i.importedName ?? ""))));
    const nodes = new Map(syntax.nodes.map((n) => [n.id, n]));
    for (const annotation of annotations) {
      const imported = frameworkImportedName(facts, annotation.name, module);
      const parsed = imported && names.includes(imported) ? parseSchedule(framework, imported, annotation, nodes, facts) : "unsupported_decorator_origin";
      const multiple = framework === "nestjs" && annotations.filter((a) => a.ownerSymbolId === annotation.ownerSymbolId).length > 1;
      const unsupported = multiple ? "multiple_decorators" : typeof parsed === "string" ? parsed : undefined;
      const owner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "method");
      const ownerClass = frameworkEnclosingClass(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, owner);
      const callable = annotation.ownerSymbolId && callableKey(facts, materialized.relativePath, annotation.ownerSymbolId);
      const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }];
      const base = { evidenceId: `${framework}-schedule:${materialized.relativePath}:${annotation.id}`, framework, adapterId: framework, adapterVersion: "1.3.0", capability: framework === "nestjs" ? "nestjs.schedule" : "spring.scheduling", relativePath: materialized.relativePath, origin: "framework_inferred" as const, confidence: "exact" as const, refs, applicable: true, attempted: true, outputKind: "relationship" as const, relationKind: "scheduled_handler" as const };
      if (unsupported) {
        evidence.push({ ...base, strategy: `schedule.${unsupported}`, scheduledUnsupportedReason: unsupported, supported: false, state: "unsupported", entities: [], sourceCandidates: [], targetCandidates: [] });
        continue;
      }
      if (typeof parsed === "string") continue;
      const identity: ScheduledIdentity | undefined = callable ? ["root", callable, parsed.trigger, parsed.spec, parsed.name, parsed.modifiers] : undefined;
      const logicalKey = identity && JSON.stringify(identity);
      const valid = logicalKey && decodeScheduledIdentity(framework, logicalKey) && owner && ownerClass && syntax.complete
        && !facts.parameters.some((p) => p.ownerSymbolId === annotation.ownerSymbolId);
      const ref = { framework, kind: "scheduled_job" as const, logicalKey: logicalKey ?? "" };
      evidence.push({ ...base, strategy: `schedule.${parsed.trigger}`, supported: true, state: valid ? "candidate" : "unknown",
        entities: valid ? [{ ref, displayName: `${callable![1]}.${callable![2]} (${parsed.trigger})`, declarationKey: base.evidenceId, confidence: "exact", refs, scheduledMetadata: parsed.metadata }] : [],
        sourceCandidates: valid ? [{ kind: "language", nodeId: owner.id }] : [], targetCandidates: valid ? [{ kind: "framework", entity: ref }] : [] });
    }
  }
  // Repeated identical declarations cannot be distinguished without an unstable ordinal.
  const groups = new Map<string, FrameworkEvidence[]>();
  for (const item of evidence) for (const entity of item.entities) groups.set(entity.ref.logicalKey, [...(groups.get(entity.ref.logicalKey) ?? []), item]);
  for (const items of groups.values()) if (items.length > 1) for (const item of items) if (item.outputKind === "relationship") item.sourceCandidates = [...item.sourceCandidates, ...item.sourceCandidates];
  return evidence;
}

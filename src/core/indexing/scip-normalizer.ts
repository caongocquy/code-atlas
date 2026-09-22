import { createHash } from "node:crypto";
import path from "node:path";

import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, type Occurrence } from "@scip-code/scip";

import type { ParsedFactsBlob, SourceRangeFact } from "../facts/facts.types.js";
import type { IndexedSourceUnit } from "./indexing.types.js";
import type { ScipBindingEvidence } from "../graph/resolver/scip-evidence.js";
import { symbolIdentity } from "../graph/resolver/identities.js";

const isSupportedUnit = (unit: IndexedSourceUnit): boolean =>
  unit.facts.language === "typescript" || unit.facts.language === "tsx" || unit.facts.language === "javascript";

function safeRelativePath(value: string | undefined): string | undefined {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return undefined;
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

function occurrenceRange(occurrence: Occurrence): [number, number, number, number] | undefined {
  const typed = occurrence.typedRange;
  if (typed.case === "singleLineRange") {
    return [typed.value.line, typed.value.startCharacter, typed.value.line, typed.value.endCharacter];
  }
  if (typed.case === "multiLineRange") {
    return [typed.value.startLine, typed.value.startCharacter, typed.value.endLine, typed.value.endCharacter];
  }
  const range = occurrence.range;
  if (range?.length === 3) return [range[0]!, range[1]!, range[0]!, range[2]!];
  if (range?.length === 4) return [range[0]!, range[1]!, range[2]!, range[3]!];
  return undefined;
}

function parserColumn(line: string, offset: number, encoding: number): number | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  if (encoding === 0 || encoding === 2) return offset <= line.length ? offset : undefined;
  if (encoding !== 1 && encoding !== 3) return undefined;
  let encodedUnits = 0;
  let utf16Units = 0;
  for (const character of line) {
    if (encodedUnits === offset) return utf16Units;
    const nextUnits = encodedUnits + (encoding === 1 ? Buffer.byteLength(character) : 1);
    if (nextUnits > offset) return undefined;
    encodedUnits = nextUnits;
    utf16Units += character.length;
  }
  return encodedUnits === offset ? utf16Units : undefined;
}

function sourceRange(lines: readonly string[], occurrence: Occurrence, encoding: number): SourceRangeFact | undefined {
  const raw = occurrenceRange(occurrence);
  if (!raw || raw.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const [startLine, startOffset, endLine, endOffset] = raw;
  if (endLine < startLine) return undefined;
  const startText = lines[startLine];
  const endText = lines[endLine];
  if (startText === undefined || endText === undefined) return undefined;
  const startColumn = parserColumn(startText, startOffset, encoding);
  const endColumn = parserColumn(endText, endOffset, encoding);
  if (startColumn === undefined || endColumn === undefined) return undefined;
  return { startLine: startLine + 1, endLine: endLine + 1, startColumn, endColumn };
}

function sourceTextAt(lines: readonly string[], range: SourceRangeFact): string | undefined {
  if (range.startLine !== range.endLine || range.startColumn === undefined || range.endColumn === undefined) return undefined;
  const line = lines[range.startLine - 1];
  if (line === undefined) return undefined;
  return line.slice(range.startColumn, range.endColumn);
}

function containsRange(parent: SourceRangeFact, child: SourceRangeFact): boolean {
  if (parent.startLine > child.startLine || parent.endLine < child.endLine) return false;
  if (parent.startLine === child.startLine && parent.startColumn !== undefined && child.startColumn !== undefined && parent.startColumn > child.startColumn) return false;
  if (parent.endLine === child.endLine && parent.endColumn !== undefined && child.endColumn !== undefined && parent.endColumn < child.endColumn) return false;
  return true;
}

function calleeToken(calleeText: string): { name: string; offset: number } | undefined {
  const withoutTypeArguments = calleeText.trim().replace(/<[^]*>\s*$/, "").replace(/[!?]+\s*$/, "").trimEnd();
  const match = /[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*$/u.exec(withoutTypeArguments);
  return match?.index === undefined ? undefined : { name: match[0], offset: match.index };
}

function symbolForFact(repositoryId: string, relativePath: string, facts: ParsedFactsBlob, fact: ParsedFactsBlob["symbols"][number]) {
  return symbolIdentity({
    repositoryId,
    relativePath,
    language: facts.language,
    kind: fact.kind,
    qualifiedName: fact.declaredQualifiedName ?? fact.name,
    discriminator: fact.localId,
  });
}

function rangeKey(range: SourceRangeFact, token: string): string {
  return JSON.stringify([range.startLine, range.startColumn, range.endLine, range.endColumn, token]);
}

function tokenPositionKey(line: number, column: number | undefined, token: string): string | undefined {
  return column === undefined ? undefined : JSON.stringify([line, column, token]);
}

function parserIndex(unit: IndexedSourceUnit) {
  const referencesByRange = new Map<string, string[]>();
  for (const fact of unit.facts.references) {
    const key = rangeKey(fact.range, fact.name);
    const values = referencesByRange.get(key) ?? [];
    values.push(fact.localId);
    referencesByRange.set(key, values);
  }
  const callsByTokenPosition = new Map<string, string[]>();
  for (const fact of unit.facts.callSites) {
    const terminal = calleeToken(fact.calleeText);
    if (!terminal || fact.range.startColumn === undefined) continue;
    const key = tokenPositionKey(fact.range.startLine, fact.range.startColumn + terminal.offset, terminal.name);
    if (!key) continue;
    const values = callsByTokenPosition.get(key) ?? [];
    values.push(fact.localId);
    callsByTokenPosition.set(key, values);
  }
  const symbolsByName = new Map<string, ParsedFactsBlob["symbols"][number][]>();
  for (const fact of unit.facts.symbols) {
    const values = symbolsByName.get(fact.name) ?? [];
    values.push(fact);
    symbolsByName.set(fact.name, values);
  }
  return { lines: unit.source.split("\n"), referencesByRange, callsByTokenPosition, symbolsByName };
}

function siteLocalIds(index: ReturnType<typeof parserIndex>, range: SourceRangeFact, token: string): readonly string[] {
  const referenceIds = index.referencesByRange.get(rangeKey(range, token)) ?? [];
  const callKey = tokenPositionKey(range.startLine, range.startColumn, token);
  const callIds = callKey ? index.callsByTokenPosition.get(callKey) ?? [] : [];
  return [...new Set([...referenceIds, ...callIds])].sort();
}

export function normalizeScipIndex(
  bytes: Uint8Array,
  input: { repositoryId: string; units: readonly IndexedSourceUnit[] },
): ScipBindingEvidence[] {
  const index = fromBinary(IndexSchema, bytes);
  const units = new Map(input.units.filter(isSupportedUnit).map((unit) => [unit.relativePath, unit]));
  const parserIndexes = new Map([...units].map(([relativePath, unit]) => [relativePath, parserIndex(unit)]));
  const definitions = new Map<string, Map<string, ReturnType<typeof symbolForFact>>>();
  const references: Array<{ unit: IndexedSourceUnit; range: SourceRangeFact; token: string; symbol: string }> = [];

  for (const document of index.documents) {
    const relativePath = safeRelativePath(document.relativePath);
    if (!relativePath) continue;
    const unit = units.get(relativePath);
    const parsed = parserIndexes.get(relativePath);
    if (!unit || !parsed) continue;
    const encoding = document.positionEncoding;
    for (const occurrence of document.occurrences) {
      const symbol = occurrence.symbol;
      if (!symbol) continue;
      const range = sourceRange(parsed.lines, occurrence, encoding);
      if (!range) continue;
      const token = sourceTextAt(parsed.lines, range);
      if (!token) continue;
      if ((occurrence.symbolRoles & 1) !== 0) {
        const matches = (parsed.symbolsByName.get(token) ?? []).filter((fact) => containsRange(fact.range, range));
        if (matches.length !== 1) continue;
        const targets = definitions.get(symbol) ?? new Map<string, ReturnType<typeof symbolForFact>>();
        const target = symbolForFact(input.repositoryId, relativePath, unit.facts, matches[0]!);
        targets.set(JSON.stringify(target), target);
        definitions.set(symbol, targets);
      } else {
        references.push({ unit, range, token, symbol });
      }
    }
  }

  const evidence = new Map<string, ScipBindingEvidence>();
  for (const reference of references) {
    const targets = definitions.get(reference.symbol);
    if (!targets || targets.size === 0) continue;
    const parsed = parserIndexes.get(reference.unit.relativePath);
    if (!parsed) continue;
    for (const siteLocalId of siteLocalIds(parsed, reference.range, reference.token)) {
      for (const target of targets.values()) {
        const identity = JSON.stringify([reference.unit.relativePath, siteLocalId, target, reference.range]);
        const item: ScipBindingEvidence = {
          sourceUnit: { repositoryId: input.repositoryId, relativePath: reference.unit.relativePath, language: reference.unit.facts.language },
          siteLocalId,
          target,
          evidenceId: `scip:${createHash("sha256").update(identity).digest("hex")}` as ScipBindingEvidence["evidenceId"],
          range: reference.range,
        };
        evidence.set(identity, item);
      }
    }
  }
  return [...evidence.values()].sort((left, right) =>
    left.sourceUnit.relativePath.localeCompare(right.sourceUnit.relativePath)
    || left.siteLocalId.localeCompare(right.siteLocalId)
    || JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)),
  );
}

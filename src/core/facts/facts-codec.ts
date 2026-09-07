import { factBlobKey } from "./facts-identity.js";
import type {
  FactBlobKey,
  ParsedFactsBlob,
  ParserIdentity,
} from "./facts.types.js";
import type { SupportedLanguage } from "../graph/parsers/types.js";

export type FactCacheLookup =
  | { kind: "hit"; facts: ParsedFactsBlob }
  | {
      kind: "miss";
      reason:
        | "absent"
        | "invalid_json"
        | "schema_mismatch"
        | "hash_mismatch"
        | "version_mismatch"
        | "parser_identity_mismatch";
    };

export type FactCacheExpectation = {
  key: FactBlobKey;
  contentHash: string;
  language: SupportedLanguage;
  parserIdentity: ParserIdentity;
  factsVersion: string;
  factsSchemaVersion: string;
};

export function encodeFacts(facts: ParsedFactsBlob): string {
  return JSON.stringify(facts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasParserIdentity(value: unknown): value is ParserIdentity {
  return isRecord(value)
    && typeof value.language === "string"
    && typeof value.parserName === "string"
    && typeof value.parserVersion === "string"
    && typeof value.grammarName === "string"
    && typeof value.grammarVersion === "string"
    && typeof value.adapterVersion === "string";
}

function hasFactsShape(value: unknown): value is ParsedFactsBlob {
  if (!isRecord(value)) return false;

  return typeof value.factsSchemaVersion === "string"
    && typeof value.factsVersion === "string"
    && typeof value.contentHash === "string"
    && typeof value.language === "string"
    && hasParserIdentity(value.parserIdentity)
    && (value.parseStatus === "complete" || value.parseStatus === "deterministic_partial")
    && Array.isArray(value.parserDiagnostics)
    && value.parserDiagnostics.every((item) => typeof item === "string")
    && Array.isArray(value.symbols)
    && Array.isArray(value.containmentScopes)
    && Array.isArray(value.imports)
    && Array.isArray(value.exports)
    && Array.isArray(value.references)
    && Array.isArray(value.callSites)
    && Array.isArray(value.bindingSeeds)
    && Array.isArray(value.declaredTypeAnnotations);
}

function sameParserIdentity(left: ParserIdentity, right: ParserIdentity): boolean {
  return left.language === right.language
    && left.parserName === right.parserName
    && left.parserVersion === right.parserVersion
    && left.grammarName === right.grammarName
    && left.grammarVersion === right.grammarVersion
    && left.adapterVersion === right.adapterVersion;
}

export function decodeFacts(
  payload: string | undefined,
  expected: FactCacheExpectation,
): FactCacheLookup {
  if (payload === undefined) return { kind: "miss", reason: "absent" };

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: "miss", reason: "invalid_json" };
  }

  if (!hasFactsShape(value)) return { kind: "miss", reason: "schema_mismatch" };
  if (value.contentHash !== expected.contentHash) return { kind: "miss", reason: "hash_mismatch" };
  if (value.factsVersion !== expected.factsVersion) return { kind: "miss", reason: "version_mismatch" };
  if (value.factsSchemaVersion !== expected.factsSchemaVersion) return { kind: "miss", reason: "schema_mismatch" };
  if (value.language !== expected.language || !sameParserIdentity(value.parserIdentity, expected.parserIdentity)) {
    return { kind: "miss", reason: "parser_identity_mismatch" };
  }
  if (factBlobKey(value) !== expected.key) return { kind: "miss", reason: "hash_mismatch" };

  return { kind: "hit", facts: value };
}

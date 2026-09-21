import { factBlobKey } from "../../src/core/facts/facts-identity.js";
import type { FactCacheExpectation } from "../../src/core/facts/facts-codec.js";
import type {
  FactLocalId,
  ParsedFactsBlob,
  SourceRangeFact,
} from "../../src/core/facts/facts.types.js";

export function range(line: number): SourceRangeFact {
  return { startLine: line, endLine: line, startColumn: 0, endColumn: 1 };
}

const parserIdentity = {
  language: "typescript" as const,
  runtimeName: "tree-sitter" as const,
  runtimeVersion: "0.25.1",
  packageName: "tree-sitter-typescript",
  grammarName: "tree-sitter-typescript",
  grammarVersion: "0.23.2",
};

export function makeFacts(overrides: Partial<ParsedFactsBlob> = {}): ParsedFactsBlob {
  return {
    factsSchemaVersion: "2.0.0",
    factsVersion: "2.0.0",
    contentHash: "content-hash",
    language: "typescript",
    parserIdentity,
    parseStatus: "complete",
    parserDiagnostics: [],
    symbols: [],
    containmentScopes: [],
    imports: [],
    exports: [],
    references: [],
    callSites: [],
    bindingSeeds: [],
    declaredTypeAnnotations: [],
    expressions: [],
    members: [],
    assignments: [],
    parameters: [],
    returns: [],
    constructors: [],
    inheritances: [],
    implementations: [],
    aliases: [],
    modules: [],
    namespaces: [],
    ...overrides,
  };
}

export function expectation(facts: ParsedFactsBlob): FactCacheExpectation {
  return {
    key: factBlobKey(facts),
    contentHash: facts.contentHash,
    language: facts.language,
    parserIdentity: facts.parserIdentity,
    factsVersion: facts.factsVersion,
    factsSchemaVersion: facts.factsSchemaVersion,
  };
}

export type { FactLocalId };

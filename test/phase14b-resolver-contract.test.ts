import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedFactsBlob, SourceRangeFact } from "../src/core/facts/facts.types.js";
import type { RepositoryIdentity } from "../src/core/repository/repository-identity.js";
import type { SupportedLanguage } from "../src/core/graph/parsers/types.js";
import {
  symbolIdentity,
  symbolIdentityKey,
} from "../src/core/graph/resolver/identities.js";
import type {
  AdapterContext,
  AdapterDiagnostic,
  AliasEvidence,
  AssignmentEvidence,
  BindingEvidence,
  CallEvidence,
  ConstructorEvidence,
  ExportEvidence,
  ImplementationEvidence,
  ImportEvidence,
  InheritanceEvidence,
  LanguageId,
  LanguageSemanticAdapter,
  MemberEvidence,
  ModuleEvidence,
  ParameterEvidence,
  ResolutionSiteIdentity,
  ResolverTraceCollector,
  ResolverTraceEvent,
  ReturnEvidence,
  ScopeIdentity,
  SemanticCapabilities,
  SemanticEvidenceBatch,
  SymbolIdentity,
  TypeAnnotationEvidence,
  TypeRef,
} from "../src/core/graph/resolver/types.js";

const repositoryIdentity: RepositoryIdentity = {
  id: "repo-id",
  identityKey: "path-v1:repo",
  rootPath: "/repo",
  displayName: "repo",
};

const sourceUnit = {
  repositoryId: repositoryIdentity.id,
  relativePath: "src/auth.ts",
  language: "typescript",
} satisfies { repositoryId: string; relativePath: string; language: LanguageId };

const range: SourceRangeFact = { startLine: 1, endLine: 1 };
const typeRef: TypeRef = {
  kind: "union",
  members: [
    { kind: "named", name: "AuthService" },
    { kind: "unknown", reason: "dynamic_expression" },
  ],
};

test("semantic contracts keep logical identity and uncertainty separate", () => {
  assert.equal(typeRef.kind, "union");

  const id = symbolIdentity({
    repositoryId: "repo",
    relativePath: "src\\auth.ts",
    language: "typescript",
    kind: "class",
    qualifiedName: " AuthService ",
    discriminator: " class:1 ",
  });

  assert.deepEqual(id, {
    repositoryId: "repo",
    relativePath: "src/auth.ts",
    language: "typescript",
    kind: "class",
    qualifiedName: "AuthService",
    discriminator: "class:1",
  });
  assert.equal(symbolIdentityKey(id), symbolIdentityKey({ ...id }));
});

test("semantic evidence batch exposes only objective adapter evidence", () => {
  const symbol: SymbolIdentity = symbolIdentity({
    repositoryId: "repo",
    relativePath: "src/auth.ts",
    language: "typescript",
    kind: "class",
    qualifiedName: "AuthService",
    discriminator: "class:1",
  });
  const scope: ScopeIdentity = { sourceUnit, localId: "scope:1" };
  const site: ResolutionSiteIdentity = { sourceUnit, localId: "call:1" };
  const base = { evidenceId: "evidence:1" as never, sourceUnit, range };

  const bindings: BindingEvidence[] = [{ ...base, kind: "binding", scope, name: "service", bindingId: "binding:1", declaredType: typeRef }];
  const imports: ImportEvidence[] = [{ ...base, kind: "import", specifier: "./auth", localName: "AuthService", importedName: "AuthService" }];
  const exports: ExportEvidence[] = [{ ...base, kind: "export", exportedName: "AuthService", localName: "AuthService" }];
  const typeAnnotations: TypeAnnotationEvidence[] = [{ ...base, kind: "type_annotation", subjectLocalId: "binding:1", type: typeRef }];
  const constructors: ConstructorEvidence[] = [{ ...base, kind: "constructor", constructedType: typeRef, resultBindingId: "binding:1" }];
  const assignments: AssignmentEvidence[] = [{ ...base, kind: "assignment", targetBindingId: "binding:1", sourceType: typeRef }];
  const parameters: ParameterEvidence[] = [{ ...base, kind: "parameter", callable: symbol, index: 0, bindingId: "binding:1", type: typeRef }];
  const returns: ReturnEvidence[] = [{ ...base, kind: "return", callable: symbol, type: typeRef }];
  const members: MemberEvidence[] = [{ ...base, kind: "member", ownerType: typeRef, memberName: "refresh", member: symbol, access: "instance" }];
  const inheritance: InheritanceEvidence[] = [{ ...base, kind: "inheritance", subject: symbol, target: typeRef, relation: "extends" }];
  const implementations: ImplementationEvidence[] = [{ ...base, kind: "implementation", subject: symbol, target: typeRef, relation: "implements" }];
  const aliases: AliasEvidence[] = [{ ...base, kind: "alias", alias: "Service", targetName: "AuthService", target: symbol }];
  const modules: ModuleEvidence[] = [{ ...base, kind: "module", module: { repositoryId: "repo", normalizedName: "auth" }, exportedNames: ["AuthService"] }];
  const calls: CallEvidence[] = [{ ...base, kind: "call", site, calleeName: "refresh", arguments: [] }];
  const diagnostics: AdapterDiagnostic[] = [{ code: "partial", message: "partial parse", sourceUnit, range }];

  const batch: SemanticEvidenceBatch = {
    bindings, imports, exports, typeAnnotations, constructors, assignments,
    parameters, returns, members, inheritance, implementations, aliases,
    modules, calls, diagnostics,
  };
  assert.equal(batch.calls[0]?.kind, "call");
  assert.equal(batch.diagnostics[0]?.sourceUnit.language, "typescript");
});

test("adapter and trace contracts retain generation context and ordered uncertainty", () => {
  const capabilities: SemanticCapabilities = {
    moduleImport: "full", localBinding: "full", directCall: "partial", declaredType: "full",
    constructorType: "partial", receiverMember: "partial", assignment: "full", parameterFlow: "partial",
    returnFlow: "partial", inheritance: "unsupported",
  };
  const facts = {} as ParsedFactsBlob;
  const context: AdapterContext = {
    generationId: "generation:1",
    repositoryIdentity,
    sourceUnit,
    resolutionVersion: "14b-2",
  };
  const adapter: LanguageSemanticAdapter = {
    adapterId: "tree-sitter-typescript",
    adapterVersion: 1,
    languages: ["typescript" satisfies SupportedLanguage],
    capabilities: () => capabilities,
    normalizeFile: () => ({
      bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [],
      parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [],
    }),
  };
  const events: ResolverTraceEvent[] = [];
  const trace: ResolverTraceCollector = {
    add(event) { events.push(event); },
    snapshot() { return events; },
  };
  trace.add({ site: { sourceUnit, localId: "call:1" }, status: "unknown", reason: "dynamic_expression" });

  assert.equal(adapter.normalizeFile(facts, context).diagnostics.length, 0);
  assert.equal(trace.snapshot()[0]?.status, "unknown");
});

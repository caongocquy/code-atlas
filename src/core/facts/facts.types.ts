import type { LanguageId, SymbolType } from "../graph/parsers/types.js";

export type ParseStatus = "complete" | "deterministic_partial";

export type FactLocalId = string & { readonly __brand: "FactLocalId" };

export type ParserIdentity = {
  language: LanguageId;
  runtimeName: "tree-sitter";
  runtimeVersion: string;
  packageName: string;
  grammarName: string;
  grammarVersion: string;
};

export type SourceRangeFact = {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
};

export type ParsedSymbolFact = {
  localId: FactLocalId;
  name: string;
  kind: SymbolType;
  range: SourceRangeFact;
  scopeId?: FactLocalId;
  declaredQualifiedName?: string;
};

export type ContainmentScopeFact = {
  localId: FactLocalId;
  kind: string;
  name?: string;
  parentId?: FactLocalId;
  range: SourceRangeFact;
};

export type ImportFact = {
  localId: FactLocalId;
  moduleSpecifier: string;
  importedName?: string;
  localName?: string;
  kind: string;
  range: SourceRangeFact;
};

export type ExportFact = {
  localId: FactLocalId;
  exportedName?: string;
  localName?: string;
  moduleSpecifier?: string;
  kind: string;
  range: SourceRangeFact;
};

export type ReferenceFact = {
  localId: FactLocalId;
  name: string;
  ownerId?: FactLocalId;
  scopeId?: FactLocalId;
  range: SourceRangeFact;
};

export type CallSiteFact = {
  localId: FactLocalId;
  calleeText: string;
  callerId?: FactLocalId;
  scopeId?: FactLocalId;
  range: SourceRangeFact;
};

export type BindingSeedFact = {
  localId: FactLocalId;
  name: string;
  bindingKind: string;
  sourceModule?: string;
  importedName?: string;
  ownerId?: FactLocalId;
  range: SourceRangeFact;
};

export type DeclaredTypeAnnotationFact = {
  localId: FactLocalId;
  ownerId: FactLocalId;
  text: string;
  range: SourceRangeFact;
};

export type ExpressionFact = {
  localId: FactLocalId;
  kind: "identifier" | "literal" | "call" | "construct" | "member" | "type_ref" | "other";
  text?: string;
  ownerScopeId?: FactLocalId;
  range: SourceRangeFact;
};

export type MemberFact = {
  localId: FactLocalId;
  ownerSymbolId?: FactLocalId;
  receiverId?: FactLocalId;
  memberName: string;
  memberKind: "field" | "method" | "property";
  access: "instance" | "static" | "extension";
  range: SourceRangeFact;
};

export type AssignmentFact = {
  localId: FactLocalId;
  targetId: FactLocalId;
  sourceExpressionId?: FactLocalId;
  sourceName?: string;
  assignmentKind: "declaration" | "reassignment" | "alias" | "function_pointer";
  range: SourceRangeFact;
};

export type ParameterFact = {
  localId: FactLocalId;
  ownerSymbolId: FactLocalId;
  name: string;
  bindingId?: FactLocalId;
  typeText?: string;
  index: number;
  receiverKind?: "method_receiver" | "go_receiver";
  range: SourceRangeFact;
};

export type ReturnFact = {
  localId: FactLocalId;
  ownerSymbolId: FactLocalId;
  expressionId?: FactLocalId;
  typeText?: string;
  range: SourceRangeFact;
};

export type ConstructorFact = {
  localId: FactLocalId;
  ownerSymbolId?: FactLocalId;
  constructedTypeName: string;
  callExpressionId?: FactLocalId;
  resultBindingId?: FactLocalId;
  range: SourceRangeFact;
};

export type InheritanceFact = {
  localId: FactLocalId;
  subjectId: FactLocalId;
  targetName: string;
  relationKind: "extends" | "base" | "trait" | "protocol" | "mixin";
  range: SourceRangeFact;
};

export type ImplementationFact = {
  localId: FactLocalId;
  subjectId: FactLocalId;
  targetName: string;
  relationKind: "implements" | "interface" | "trait_impl" | "protocol_conformance" | "extension" | "mixin";
  range: SourceRangeFact;
};

export type AliasFact = {
  localId: FactLocalId;
  aliasName: string;
  targetName: string;
  targetId?: FactLocalId;
  aliasKind: "import" | "type" | "namespace" | "value";
  range: SourceRangeFact;
};

export type ModuleFact = {
  localId: FactLocalId;
  name: string;
  moduleKind: "file" | "module" | "package" | "namespace";
  exported: boolean;
  range: SourceRangeFact;
};

export type NamespaceFact = {
  localId: FactLocalId;
  name: string;
  ownerId?: FactLocalId;
  range: SourceRangeFact;
};

export type ParsedFactsBlob = {
  factsSchemaVersion: string;
  factsVersion: string;
  contentHash: string;
  language: LanguageId;
  parserIdentity: ParserIdentity;
  parseStatus: ParseStatus;
  parserDiagnostics: string[];
  symbols: ParsedSymbolFact[];
  containmentScopes: ContainmentScopeFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  references: ReferenceFact[];
  callSites: CallSiteFact[];
  bindingSeeds: BindingSeedFact[];
  declaredTypeAnnotations: DeclaredTypeAnnotationFact[];
  expressions: readonly ExpressionFact[];
  members: readonly MemberFact[];
  assignments: readonly AssignmentFact[];
  parameters: readonly ParameterFact[];
  returns: readonly ReturnFact[];
  constructors: readonly ConstructorFact[];
  inheritances: readonly InheritanceFact[];
  implementations: readonly ImplementationFact[];
  aliases: readonly AliasFact[];
  modules: readonly ModuleFact[];
  namespaces: readonly NamespaceFact[];
};

export type FactBlobKey = string & { readonly __brand: "FactBlobKey" };

export type FileFactBinding = {
  repositoryId: string;
  relativePath: string;
  generationId: string;
  factBlobKey: FactBlobKey;
  contentHash: string;
  language: LanguageId;
};

export type MaterializedFileFacts = {
  relativePath: string;
  facts: ParsedFactsBlob;
};

export type IndexVersionDomains = {
  schemaVersion: string;
  factsSchemaVersion: string;
  factsVersion: string;
  resolutionVersion: string;
  derivedVersion: string;
};

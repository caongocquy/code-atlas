import type { SupportedLanguage, SymbolType } from "../graph/parsers/types.js";

export type ParseStatus = "complete" | "deterministic_partial";

export type FactLocalId =
  | `symbol:${number}`
  | `scope:${number}`
  | `import:${number}`
  | `export:${number}`
  | `reference:${number}`
  | `call:${number}`
  | `binding:${number}`
  | `type:${number}`;

export type ParserIdentity = {
  language: SupportedLanguage;
  parserName: string;
  parserVersion: string;
  grammarName: string;
  grammarVersion: string;
  adapterVersion: string;
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

export type ParsedFactsBlob = {
  factsSchemaVersion: string;
  factsVersion: string;
  contentHash: string;
  language: SupportedLanguage;
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
};

export type FactBlobKey = string & { readonly __brand: "FactBlobKey" };

export type FileFactBinding = {
  repositoryId: string;
  relativePath: string;
  generationId: string;
  factBlobKey: FactBlobKey;
  contentHash: string;
  language: SupportedLanguage;
};

export type MaterializedFileFacts = {
  relativePath: string;
  facts: ParsedFactsBlob;
};

export type IndexVersionDomains = {
  schemaVersion: string;
  factsVersion: string;
  resolutionVersion: string;
  derivedVersion: string;
};

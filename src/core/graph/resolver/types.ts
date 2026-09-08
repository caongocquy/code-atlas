import type { ParsedFactsBlob, SourceRangeFact } from "../../facts/facts.types.js";
import type { RepositoryIdentity } from "../../repository/repository-identity.js";
import type { SupportedLanguage } from "../parsers/types.js";
import type { BudgetLedger } from "./budgets.js";
import type {
  ExpressionIdentity,
  ModuleIdentity,
  ResolutionSiteIdentity,
  ScopeIdentity,
  SourceUnitIdentity,
  SymbolIdentity,
} from "./identities.js";
import type { ResolverMemo } from "./memo.js";

export type LanguageId = SupportedLanguage;

export type {
  ExpressionIdentity,
  ModuleIdentity,
  ResolutionSiteIdentity,
  ScopeIdentity,
  SourceUnitIdentity,
  SymbolIdentity,
} from "./identities.js";

export type EvidenceId = string & { readonly __brand: "EvidenceId" };

export type UnknownReason =
  | "dynamic_expression"
  | "receiver_type_unknown"
  | "unresolved_import"
  | "insufficient_evidence"
  | "weak_only"
  | "runtime_dispatch";

export type UnsupportedReason =
  | "language_capability_unsupported"
  | "compiler_semantics_required"
  | "framework_semantics_required"
  | "preprocessor_semantics_required";

export type BudgetReason =
  | "candidate_expansion_limit"
  | "binding_hop_limit"
  | "return_depth_limit"
  | "inheritance_depth_limit"
  | "member_candidate_limit"
  | "expression_node_limit"
  | "propagation_round_limit";

export type AmbiguityReason =
  | "multiple_candidates"
  | "union_receiver"
  | "overload_set"
  | "multiple_implementations";

export type CapabilityLevel = "full" | "partial" | "unsupported" | "not-applicable";

export type SemanticCapability =
  | "moduleImport"
  | "localBinding"
  | "directCall"
  | "declaredType"
  | "constructorType"
  | "receiverMember"
  | "assignment"
  | "parameterFlow"
  | "returnFlow"
  | "inheritance";

export type SemanticCapabilities = Readonly<Record<SemanticCapability, CapabilityLevel>>;

export type TypeRef =
  | { kind: "known"; symbol: SymbolIdentity }
  | { kind: "named"; name: string; qualification?: readonly string[]; module?: ModuleIdentity }
  | { kind: "union"; members: readonly TypeRef[] }
  | { kind: "unknown"; reason: UnknownReason };

export type EvidenceBase = {
  evidenceId: EvidenceId;
  sourceUnit: SourceUnitIdentity;
  range: SourceRangeFact;
};

export type BindingEvidence = EvidenceBase & {
  kind: "binding";
  scope: ScopeIdentity;
  name: string;
  bindingId: string;
  declaredType?: TypeRef;
};

export type ImportEvidence = EvidenceBase & {
  kind: "import";
  specifier: string;
  localName?: string;
  importedName?: string;
  module?: ModuleIdentity;
  resolvedPath?: string;
};

export type ExportEvidence = EvidenceBase & {
  kind: "export";
  exportedName: string;
  localName?: string;
  module?: ModuleIdentity;
};

export type TypeAnnotationEvidence = EvidenceBase & {
  kind: "type_annotation";
  subjectLocalId: string;
  type: TypeRef;
};

export type ConstructorEvidence = EvidenceBase & {
  kind: "constructor";
  constructedType: TypeRef;
  resultBindingId?: string;
};

export type AssignmentEvidence = EvidenceBase & {
  kind: "assignment";
  targetBindingId: string;
  sourceExpression?: ExpressionIdentity;
  sourceType?: TypeRef;
};

export type ParameterEvidence = EvidenceBase & {
  kind: "parameter";
  callable: SymbolIdentity;
  index: number;
  bindingId: string;
  type?: TypeRef;
};

export type ReturnEvidence = EvidenceBase & {
  kind: "return";
  callable: SymbolIdentity;
  expression?: ExpressionIdentity;
  type?: TypeRef;
};

export type MemberEvidence = EvidenceBase & {
  kind: "member";
  ownerType: TypeRef;
  memberName: string;
  member: SymbolIdentity;
  access: "instance" | "static" | "extension";
};

export type InheritanceEvidence = EvidenceBase & {
  kind: "inheritance";
  subject: SymbolIdentity;
  target: TypeRef;
  relation: "extends" | "base" | "trait" | "protocol" | "mixin";
};

export type ImplementationEvidence = EvidenceBase & {
  kind: "implementation";
  subject: SymbolIdentity;
  target: TypeRef;
  relation: "implements" | "interface" | "trait_impl" | "protocol_conformance" | "extension" | "mixin";
};

export type AliasEvidence = EvidenceBase & {
  kind: "alias";
  alias: string;
  targetName: string;
  target?: SymbolIdentity | TypeRef;
};

export type ModuleEvidence = EvidenceBase & {
  kind: "module";
  module: ModuleIdentity;
  exportedNames: readonly string[];
};

export type CallEvidence = EvidenceBase & {
  kind: "call";
  site: ResolutionSiteIdentity;
  calleeName: string;
  receiver?: ExpressionIdentity;
  arguments: readonly ExpressionIdentity[];
};

export type AdapterDiagnostic = {
  code: string;
  message: string;
  sourceUnit: SourceUnitIdentity;
  range?: SourceRangeFact;
  candidates?: readonly SymbolIdentity[];
};

export type SemanticEvidenceBatch = {
  bindings: readonly BindingEvidence[];
  imports: readonly ImportEvidence[];
  exports: readonly ExportEvidence[];
  typeAnnotations: readonly TypeAnnotationEvidence[];
  constructors: readonly ConstructorEvidence[];
  assignments: readonly AssignmentEvidence[];
  parameters: readonly ParameterEvidence[];
  returns: readonly ReturnEvidence[];
  members: readonly MemberEvidence[];
  inheritance: readonly InheritanceEvidence[];
  implementations: readonly ImplementationEvidence[];
  aliases: readonly AliasEvidence[];
  modules: readonly ModuleEvidence[];
  calls: readonly CallEvidence[];
  diagnostics: readonly AdapterDiagnostic[];
};

export type TypeEnvironmentInput = {
  generationId: string;
  symbols: readonly SymbolIdentity[];
  evidence: readonly SemanticEvidenceBatch[];
  budget: BudgetLedger;
  memo: ResolverMemo;
};

export type AdapterContext = {
  generationId: string;
  repositoryIdentity: RepositoryIdentity;
  sourceUnit: SourceUnitIdentity;
  resolutionVersion: string;
};

export type LanguageSemanticAdapter = {
  adapterId: string;
  adapterVersion: number;
  languages: readonly LanguageId[];
  capabilities(language: LanguageId): SemanticCapabilities;
  normalizeFile(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch;
};

export type ResolutionStrategyId =
  | "lexical-local"
  | "imports-exports"
  | "explicit-type"
  | "constructor"
  | "assignment"
  | "parameter"
  | "return"
  | "alias"
  | "inheritance"
  | "receiver-member"
  | "chained-call"
  | "bounded-interprocedural";

export type ResolverTraceEvent = {
  site: ResolutionSiteIdentity;
  status: "attempted" | "ambiguous" | "unknown" | "unsupported" | "budget_exhausted";
  strategy?: ResolutionStrategyId;
  reason?: string;
};

export type ResolverTraceCollector = {
  add(event: ResolverTraceEvent): void;
  snapshot(): readonly ResolverTraceEvent[];
};

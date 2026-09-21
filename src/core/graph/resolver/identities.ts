import { LANGUAGE_IDS, type SupportedLanguage } from "../parsers/types.js";
import type { LanguageId } from "./types.js";

export type SourceUnitIdentity = {
  repositoryId: string;
  relativePath: string;
  language: LanguageId;
};

export type ScopeIdentity = {
  sourceUnit: SourceUnitIdentity;
  localId: string;
  parentLocalId?: string;
};

export type SymbolIdentity = {
  repositoryId: string;
  relativePath: string;
  language: LanguageId;
  kind: string;
  qualifiedName: string;
  discriminator: string;
};

export type ModuleIdentity = {
  repositoryId: string;
  normalizedName: string;
  relativePath?: string;
};

export type ExpressionIdentity = {
  sourceUnit: SourceUnitIdentity;
  localId: string;
};

export type ResolutionSiteIdentity = {
  sourceUnit: SourceUnitIdentity;
  localId: string;
};

export function symbolIdentity(input: SymbolIdentity): SymbolIdentity {
  return {
    ...input,
    relativePath: input.relativePath.replaceAll("\\", "/"),
    qualifiedName: input.qualifiedName.trim(),
    discriminator: input.discriminator.trim(),
  };
}

export function symbolIdentityKey(input: SymbolIdentity): string {
  const value = symbolIdentity(input);
  return JSON.stringify([
    value.repositoryId,
    value.relativePath,
    value.language,
    value.kind,
    value.qualifiedName,
    value.discriminator,
  ]);
}

export function isSymbolIdentityKey(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed.some((item) => typeof item !== "string" || item.length === 0)) return false;
    const [repositoryId, relativePath, language, kind, qualifiedName, discriminator] = parsed;
    if (!LANGUAGE_IDS.includes(language as SupportedLanguage)) return false;
    return symbolIdentityKey({
      repositoryId,
      relativePath,
      language: language as SupportedLanguage,
      kind,
      qualifiedName,
      discriminator,
    }) === value;
  } catch {
    return false;
  }
}

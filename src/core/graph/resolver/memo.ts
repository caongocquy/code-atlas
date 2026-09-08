import type {
  EvidenceId,
  SymbolIdentity,
  TypeRef,
  UnknownReason,
} from "./types.js";

export type MemoEntry =
  | { kind: "types"; values: readonly TypeRef[]; evidenceIds: readonly EvidenceId[] }
  | { kind: "symbols"; values: readonly SymbolIdentity[]; evidenceIds: readonly EvidenceId[] }
  | { kind: "unknown"; reason: UnknownReason; evidenceIds: readonly EvidenceId[]; stable: true };

export type ResolverMemo = {
  get(key: string): MemoEntry | undefined;
  set(key: string, value: MemoEntry): void;
  size(): number;
};

export function createResolverMemo(): ResolverMemo {
  const values = new Map<string, MemoEntry>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    size: () => values.size,
  };
}

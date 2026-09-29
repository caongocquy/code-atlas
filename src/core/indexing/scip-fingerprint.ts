import { createHash } from "node:crypto";
import path from "node:path";

export const SCIP_RESOLUTION_VERSION = "1.0.0";
export const SCIP_SCHEMA_VERSION = "@scip-code/scip@0.10.0";
export const SCIP_PROTOCOL_VERSION = 0;

export type ScipFingerprintInput = {
  repositoryId: string;
  sourceHashes: ReadonlyMap<string, string>;
  configHashes: ReadonlyMap<string, string>;
  lockfileHashes: ReadonlyMap<string, string>;
  toolVersion: string | null;
  scipSchemaVersion: string;
  scipProtocolVersion: number;
  scipResolutionVersion: string;
  resolutionVersion: string;
};

const sortedEntries = (entries: ReadonlyMap<string, string>): readonly (readonly [string, string])[] =>
  [...entries].sort(([left], [right]) => left.localeCompare(right));

export function computeScipFingerprint(input: ScipFingerprintInput): string {
  const sources = sortedEntries(new Map([...input.sourceHashes].filter(([file]) =>
    [".ts", ".tsx", ".js", ".jsx"].includes(path.posix.extname(file).toLowerCase()),
  )));
  const identity = JSON.stringify({
    repositoryId: input.repositoryId,
    sources,
    configs: sortedEntries(input.configHashes),
    lockfiles: sortedEntries(input.lockfileHashes),
    tool: { name: "scip-typescript", version: input.toolVersion },
    scipSchemaVersion: input.scipSchemaVersion,
    scipProtocolVersion: input.scipProtocolVersion,
    scipResolutionVersion: input.scipResolutionVersion,
    resolutionVersion: input.resolutionVersion,
  });
  return createHash("sha256").update(identity).digest("hex");
}

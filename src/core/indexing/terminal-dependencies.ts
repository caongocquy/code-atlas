import fs from "node:fs/promises";
import path from "node:path";
import { createFileHash } from "../repository/file-hash.js";

export type TerminalDependency = {
  ownerPath: string;
  specifier: string;
  relativePath: string;
  canonicalPath: string | null;
  contentHash: string | null;
  state: "resolved" | "missing" | "ambiguous" | "outside";
};

export function isTerminalSpecifier(specifier: string): boolean {
  return /^(?:\.\.?\/).*\.(?:css|json)$/.test(specifier);
}

/** Only literal CSS/JSON files are terminals. No symbols or runtime semantics. */
export async function readTerminalDependency(repoPath: string, ownerPath: string, specifier: string): Promise<TerminalDependency> {
  const relativePath = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), specifier));
  const record: TerminalDependency = { ownerPath, specifier, relativePath, canonicalPath: null, contentHash: null, state: "missing" };
  if (!isTerminalSpecifier(specifier) || relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath)) return { ...record, state: "outside" };
  const target = path.join(repoPath, relativePath);
  try {
    const stat = await fs.lstat(target);
    // Symlink aliases cannot prove unambiguous local ownership under this policy.
    if (stat.isSymbolicLink()) return { ...record, state: "ambiguous" };
    if (!stat.isFile()) return record;
    const canonicalRoot = await fs.realpath(repoPath), canonicalTarget = await fs.realpath(target);
    const canonicalPath = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
    if (canonicalPath.startsWith("../") || path.isAbsolute(canonicalPath)) return { ...record, state: "outside" };
    const before = await fs.readFile(target);
    const after = await fs.readFile(target);
    if (!before.equals(after)) throw new Error(`Terminal asset changed during acquisition: ${relativePath}`);
    return { ...record, canonicalPath, contentHash: createFileHash(before.toString("utf8")), state: "resolved" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return record;
    throw error;
  }
}

export function decodeTerminalDependencies(value: unknown): TerminalDependency[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => entry && typeof entry === "object"
    && typeof entry.ownerPath === "string" && typeof entry.specifier === "string" && isTerminalSpecifier(entry.specifier)
    && typeof entry.relativePath === "string" && !entry.relativePath.startsWith("../") && !path.isAbsolute(entry.relativePath)
    && ["resolved", "missing", "ambiguous", "outside"].includes(entry.state)
    && (entry.state === "resolved" ? typeof entry.canonicalPath === "string" && typeof entry.contentHash === "string" : entry.canonicalPath === null && entry.contentHash === null))) return undefined;
  return value as TerminalDependency[];
}

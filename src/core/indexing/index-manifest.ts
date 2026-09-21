import { randomUUID } from "node:crypto";

import type { FileFactBinding, IndexVersionDomains } from "../facts/facts.types.js";

export type IndexManifest = {
  generationId: string;
  files: FileFactBinding[];
  createdAt: string;
  versions: IndexVersionDomains;
};

export type IndexGeneration = {
  id: string;
  repositoryId: string;
  parentGenerationId?: string;
  versions: IndexVersionDomains;
  status: "candidate" | "committed";
  manifest: IndexManifest;
};

export function createCandidateGeneration(
  repositoryId: string,
  parentGenerationId: string | undefined,
  versions: IndexVersionDomains,
  files: FileFactBinding[],
): IndexGeneration {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const manifest: IndexManifest = {
    generationId: id,
    files: files.map((file) => ({ ...file, generationId: id, repositoryId })),
    createdAt,
    versions: { ...versions },
  };
  return {
    id,
    repositoryId,
    ...(parentGenerationId ? { parentGenerationId } : {}),
    versions: { ...versions },
    status: "candidate",
    manifest,
  };
}

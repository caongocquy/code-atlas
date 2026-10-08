import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class IndexWriterLockError extends Error {
  readonly code = "INDEX_OPERATION_ALREADY_RUNNING";

  constructor(repoPath: string, options?: ErrorOptions) {
    super(`An index operation is already running for ${repoPath}`, options);
    this.name = "IndexWriterLockError";
  }
}

export async function acquireIndexWriterLock(repoPath: string): Promise<() => Promise<void>> {
  const canonicalRepoPath = await realpath(repoPath);
  const statePath = path.join(canonicalRepoPath, ".codeatlas");
  await mkdir(statePath, { recursive: true });

  const database = new DatabaseSync(path.join(statePath, "index-writer.db"));
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  } catch (error) {
    database.close();
    if (isDatabaseBusy(error)) {
      throw new IndexWriterLockError(canonicalRepoPath, { cause: error });
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      database.exec("ROLLBACK;");
    } finally {
      database.close();
    }
  };
}

function isDatabaseBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_INDEX_METADATA_DB_PATH = ".code-rag/index-metadata.db";

export type IndexType = "vector" | "graph";

export type IndexMetadata = {
  version: string;
  updatedAt: string;
};

type TableInfoRow = {
  name: string;
  type: string;
};

function ensureDatabaseDirectory(databasePath: string): void {
  const directory = path.dirname(path.resolve(databasePath));

  fs.mkdirSync(directory, {
    recursive: true,
  });
}

export class IndexMetadataStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = DEFAULT_INDEX_METADATA_DB_PATH) {
    ensureDatabaseDirectory(databasePath);

    this.database = new DatabaseSync(databasePath);

    this.database.exec("PRAGMA journal_mode = WAL;");

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS index_metadata (
        repo_id TEXT NOT NULL,
        index_type TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL,

        PRIMARY KEY (
          repo_id,
          index_type
        )
      );
    `);

    this.migrateVersionColumnIfNeeded();

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_index_metadata_repo
        ON index_metadata (
          repo_id
        );
    `);
  }

  private migrateVersionColumnIfNeeded(): void {
    const columns = this.database
      .prepare(
        `
          PRAGMA table_info(index_metadata)
        `,
      )
      .all() as unknown as TableInfoRow[];

    const versionColumn = columns.find((column) => column.name === "version");

    if (!versionColumn || versionColumn.type.toUpperCase() === "TEXT") {
      return;
    }

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      this.database.exec(`
        ALTER TABLE index_metadata
        RENAME TO index_metadata_old;

        CREATE TABLE index_metadata (
          repo_id TEXT NOT NULL,
          index_type TEXT NOT NULL,
          version TEXT NOT NULL,
          updated_at TEXT NOT NULL,

          PRIMARY KEY (
            repo_id,
            index_type
          )
        );

        INSERT INTO index_metadata (
          repo_id,
          index_type,
          version,
          updated_at
        )
        SELECT
          repo_id,
          index_type,
          CAST(version AS TEXT),
          updated_at
        FROM index_metadata_old;

        DROP TABLE index_metadata_old;
      `);

      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");

      throw error;
    }
  }

  getVersion(repoId: string, indexType: IndexType): string | undefined {
    return this.getMetadata(repoId, indexType)?.version;
  }

  getMetadata(repoId: string, indexType: IndexType): IndexMetadata | undefined {
    const row = this.database
      .prepare(
        `
          SELECT version, updated_at
          FROM index_metadata
          WHERE
            repo_id = ?
            AND index_type = ?
        `,
      )
      .get(repoId, indexType) as
      | {
          version: string;
          updated_at: string;
        }
      | undefined;

    return row
      ? {
          version: row.version,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  setVersion(repoId: string, indexType: IndexType, version: string): void {
    this.database
      .prepare(
        `
        INSERT INTO index_metadata (
          repo_id,
          index_type,
          version,
          updated_at
        )
        VALUES (?, ?, ?, ?)

        ON CONFLICT (
          repo_id,
          index_type
        )
        DO UPDATE SET
          version =
            excluded.version,
          updated_at =
            excluded.updated_at
      `,
      )
      .run(repoId, indexType, version, new Date().toISOString());
  }

  close(): void {
    this.database.close();
  }
}

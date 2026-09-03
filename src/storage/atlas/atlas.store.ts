import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initializeAtlasSchema, ATLAS_SCHEMA_VERSION } from "./atlas.schema.js";
import type {
  AtlasCapability,
  AtlasFileCapabilityState,
  AtlasIndexAxis,
  AtlasRepository,
  CapabilityState,
  FileCapabilityStateInput,
  GraphFileState,
  GraphFileUpdate,
  IndexMetadata,
  LexicalFileUpdate,
  LexicalSearchRow,
} from "./atlas.types.js";
import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode, GraphNodeType } from "../../core/graph/types.js";
import type { RepositoryIdentity } from "../../core/repository/repository-identity.js";

export const DEFAULT_ATLAS_DB_PATH = ".codeatlas/atlas.db";

type RepositoryRow = {
  id: string;
  identity_key: string;
  root_path: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};

type FileStateRow = {
  file: string;
  file_hash: string | null;
};

type CapabilityStateRow = {
  repository_id: string;
  file_path: string;
  file_hash: string | null;
  capability: AtlasCapability;
  version: string;
  state: CapabilityState;
  generation: string | null;
  item_count: number;
  last_error: string | null;
  updated_at: string;
};

function ensureDatabaseDirectory(databasePath: string): void {
  const directory = path.dirname(path.resolve(databasePath));

  fs.mkdirSync(directory, { recursive: true });

  const ignorePath = path.join(directory, ".gitignore");
  const existing = fs.existsSync(ignorePath)
    ? fs.readFileSync(ignorePath, "utf8")
    : "";
  const lines = new Set(existing.split(/\r?\n/));
  const missing = ["*", "!.gitignore"].filter((rule) => !lines.has(rule));

  if (missing.length > 0) {
    const prefix = existing.trimEnd();
    fs.writeFileSync(
      ignorePath,
      `${prefix}${prefix ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }
}

function repositoryFromRow(row: RepositoryRow): AtlasRepository {
  return {
    id: row.id,
    identityKey: row.identity_key,
    rootPath: row.root_path,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AtlasStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = DEFAULT_ATLAS_DB_PATH) {
    ensureDatabaseDirectory(databasePath);

    const database = new DatabaseSync(databasePath);

    try {
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA journal_mode = WAL;");
      initializeAtlasSchema(database);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  ensureRepository(identity: RepositoryIdentity): AtlasRepository {
    const now = new Date().toISOString();
    const byIdentity = this.database
      .prepare("SELECT * FROM repositories WHERE identity_key = ?")
      .get(identity.identityKey) as RepositoryRow | undefined;
    let row = byIdentity;

    if (row) {
      this.database
        .prepare(
          `UPDATE repositories
           SET root_path = ?, display_name = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(identity.rootPath, identity.displayName, now, row.id);
    } else {
      const byId = this.database
        .prepare("SELECT * FROM repositories WHERE id = ?")
        .get(identity.id) as RepositoryRow | undefined;

      if (byId) {
        this.database
          .prepare(
            `UPDATE repositories
             SET identity_key = ?, root_path = ?, display_name = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            identity.identityKey,
            identity.rootPath,
            identity.displayName,
            now,
            byId.id,
          );
        row = byId;
      } else {
        this.database
          .prepare(
            `INSERT INTO repositories
             (id, identity_key, root_path, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            identity.id,
            identity.identityKey,
            identity.rootPath,
            identity.displayName,
            now,
            now,
          );
        row = {
          id: identity.id,
          identity_key: identity.identityKey,
          root_path: identity.rootPath,
          display_name: identity.displayName,
          created_at: now,
          updated_at: now,
        };
      }
    }

    const repository = row
      ? repositoryFromRow({
          ...row,
          identity_key: identity.identityKey,
          root_path: identity.rootPath,
          display_name: identity.displayName,
          updated_at: now,
        })
      : undefined;

    if (!repository) {
      throw new Error("AtlasStore failed to initialize repository identity");
    }

    this.setVersionRow(repository.id, "schema", ATLAS_SCHEMA_VERSION, now);

    return repository;
  }

  private ensureRepositoryId(repoId: string): void {
    const existing = this.database
      .prepare("SELECT 1 FROM repositories WHERE id = ?")
      .get(repoId);

    if (existing) {
      return;
    }

    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO repositories
         (id, identity_key, root_path, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(repoId, `legacy:${repoId}`, repoId, path.basename(repoId), now, now);
    this.setVersionRow(repoId, "schema", ATLAS_SCHEMA_VERSION, now);
  }

  getFileStates(repoId: string): Map<string, GraphFileState> {
    const rows = this.database
      .prepare(
        `SELECT f.path AS file, c.file_hash
         FROM files f
         JOIN file_capability_state c
           ON c.repository_id = f.repository_id
          AND c.file_path = f.path
          AND c.capability = 'graph'
         WHERE f.repository_id = ? AND c.file_hash IS NOT NULL`,
      )
      .all(repoId) as FileStateRow[];

    return new Map(
      rows.map((row) => [row.file, { fileHash: row.file_hash! }]),
    );
  }

  getIndexedFilePaths(repoId: string): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT path AS file FROM files WHERE repository_id = ?
         UNION
         SELECT file_path AS file
         FROM file_capability_state
         WHERE repository_id = ?`,
      )
      .all(repoId, repoId) as Array<{ file: string }>;

    return new Set(rows.map((row) => row.file));
  }

  replaceGraph(
    repoId: string,
    graph: CodeGraph,
    fileHashes: Map<string, string>,
    graphVersion?: string,
  ): void {
    this.ensureRepositoryId(repoId);

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const nodesByFile = new Map<string, number>();

    for (const node of graph.nodes) {
      nodesByFile.set(node.file, (nodesByFile.get(node.file) ?? 0) + 1);
    }

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      this.database.prepare("DELETE FROM edges WHERE repository_id = ?").run(repoId);
      this.database.prepare("DELETE FROM symbols WHERE repository_id = ?").run(repoId);
      this.deleteCapabilityStates(repoId, "graph");

      const insertNode = this.createInsertNodeStatement();
      const insertEdge = this.createInsertEdgeStatement();

      for (const node of graph.nodes) {
        this.insertNode(insertNode, repoId, node);
      }

      for (const edge of graph.edges) {
        const sourceNode = nodeById.get(edge.from);

        if (!sourceNode) {
          throw new Error(`Missing source node for edge: ${edge.from}`);
        }

        this.insertEdge(insertEdge, repoId, sourceNode.file, edge);
      }

      for (const [file, fileHash] of fileHashes) {
        this.upsertFile(file, repoId, fileHash);
        this.upsertCapabilityState(repoId, file, "graph", {
          version: graphVersion ?? "legacy",
          state: "ready",
          itemCount: nodesByFile.get(file) ?? 0,
          fileHash,
        });
      }

      this.deleteOrphanFiles(repoId);

      if (graphVersion) {
        this.setVersionRow(repoId, "graph", graphVersion, new Date().toISOString());
      }

      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  applyFileUpdates(
    repoId: string,
    updates: GraphFileUpdate[],
    deletedFiles: string[],
    graphVersion?: string,
  ): void {
    this.ensureRepositoryId(repoId);
    this.database.exec("BEGIN IMMEDIATE;");

    try {
      const deleteOwnedEdges = this.database.prepare(
        "DELETE FROM edges WHERE repository_id = ? AND owner_file = ?",
      );
      const deleteNodes = this.database.prepare(
        "DELETE FROM symbols WHERE repository_id = ? AND file_path = ?",
      );

      for (const file of deletedFiles) {
        deleteOwnedEdges.run(repoId, file);
        deleteNodes.run(repoId, file);
        this.deleteCapabilityState(repoId, file, "graph");
      }

      for (const update of updates) {
        deleteOwnedEdges.run(repoId, update.file);
        deleteNodes.run(repoId, update.file);
        this.deleteCapabilityState(repoId, update.file, "graph");
        this.upsertFile(update.file, repoId, update.fileHash);

        const insertNode = this.createInsertNodeStatement();
        const insertEdge = this.createInsertEdgeStatement();
        const nodeById = new Map(update.nodes.map((node) => [node.id, node]));

        for (const node of update.nodes) {
          this.insertNode(insertNode, repoId, node);
        }

        for (const edge of update.edges) {
          const sourceNode = nodeById.get(edge.from);

          if (!sourceNode) {
            throw new Error(`Missing source node for edge: ${edge.from}`);
          }

          this.insertEdge(insertEdge, repoId, update.file, edge);
        }

        this.upsertCapabilityState(repoId, update.file, "graph", {
          version: graphVersion ?? "legacy",
          state: "ready",
          itemCount: update.nodes.length,
          fileHash: update.fileHash,
        });
      }

      for (const file of deletedFiles) {
        this.deleteOrphanFile(repoId, file);
      }

      if (graphVersion) {
        this.setVersionRow(repoId, "graph", graphVersion, new Date().toISOString());
      }

      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  loadGraph(repoId: string): CodeGraph {
    const nodeRows = this.database
      .prepare(
        `SELECT id, type, name, qualified_name, file_path, start_line, end_line
         FROM symbols WHERE repository_id = ?`,
      )
      .all(repoId) as Array<{
      id: string;
      type: string;
      name: string;
      qualified_name: string | null;
      file_path: string;
      start_line: number | null;
      end_line: number | null;
    }>;
    const edgeRows = this.database
      .prepare(
        `SELECT from_symbol_id, to_symbol_id, type
         FROM edges WHERE repository_id = ?`,
      )
      .all(repoId) as Array<{
      from_symbol_id: string;
      to_symbol_id: string;
      type: string;
    }>;

    return {
      nodes: nodeRows.map((row) => ({
        id: row.id,
        type: row.type as GraphNodeType,
        name: row.name,
        qualifiedName: row.qualified_name ?? undefined,
        file: row.file_path,
        startLine: row.start_line ?? undefined,
        endLine: row.end_line ?? undefined,
      })),
      edges: edgeRows.map((row) => ({
        from: row.from_symbol_id,
        to: row.to_symbol_id,
        type: row.type as GraphEdgeType,
      })),
    };
  }

  replaceLexicalDocuments(
    repoId: string,
    updates: LexicalFileUpdate[],
    deletedFiles: string[],
    lexicalVersion: string,
  ): void {
    this.ensureRepositoryId(repoId);
    this.database.exec("BEGIN IMMEDIATE;");

    try {
      for (const file of deletedFiles) {
        this.deleteLexicalFile(repoId, file);
        this.deleteCapabilityState(repoId, file, "lexical");
      }

      for (const update of updates) {
        this.deleteLexicalFile(repoId, update.file);
        this.deleteCapabilityState(repoId, update.file, "lexical");
        this.upsertFile(update.file, repoId, update.fileHash);

        for (const document of update.documents) {
          this.database
            .prepare(
              `INSERT INTO lexical_documents
               (repository_id, document_id, file, symbol_name, qualified_name,
                symbol_type, content, start_line, end_line)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              repoId,
              document.documentId,
              document.file,
              document.symbolName ?? null,
              document.qualifiedName ?? null,
              document.symbolType ?? null,
              document.content,
              document.startLine ?? null,
              document.endLine ?? null,
            );
        }

        this.upsertCapabilityState(repoId, update.file, "lexical", {
          fileHash: update.fileHash,
          version: lexicalVersion,
          state: "ready",
          itemCount: update.documents.length,
        });
      }

      for (const file of deletedFiles) {
        this.deleteOrphanFile(repoId, file);
      }

      this.setVersionRow(
        repoId,
        "lexical",
        lexicalVersion,
        new Date().toISOString(),
      );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  searchLexical(
    repoId: string,
    matchQuery: string,
    limit: number,
    filePrefix?: string,
  ): LexicalSearchRow[] {
    if (limit <= 0 || !matchQuery.trim()) {
      return [];
    }

    const rows = this.database
      .prepare(
        `SELECT d.document_id, d.file, d.symbol_name, d.qualified_name,
                d.symbol_type, d.content, d.start_line, d.end_line,
                bm25(lexical_documents, 1.5, 4.0, 3.0, 1.0, 1.0) AS score,
                snippet(lexical_documents, 6, '[', ']', '…', 18) AS snippet
         FROM lexical_documents d
         JOIN file_capability_state c
           ON c.repository_id = d.repository_id
          AND c.file_path = d.file
          AND c.capability = 'lexical'
          AND c.state = 'ready'
         WHERE d.repository_id = ?
           AND lexical_documents MATCH ?
           AND (? IS NULL OR d.file LIKE ?)
         ORDER BY score ASC, d.file ASC, d.start_line ASC, d.document_id ASC
         LIMIT ?`,
      )
      .all(repoId, matchQuery, filePrefix ?? null, filePrefix ? `${filePrefix}%` : null, limit) as Array<{
      document_id: string;
      file: string;
      symbol_name: string | null;
      qualified_name: string | null;
      symbol_type: string | null;
      content: string;
      start_line: number | null;
      end_line: number | null;
      score: number;
      snippet: string;
    }>;

    return rows.map((row) => ({
      documentId: row.document_id,
      file: row.file,
      symbolName: row.symbol_name ?? undefined,
      qualifiedName: row.qualified_name ?? undefined,
      symbolType: row.symbol_type ?? undefined,
      content: row.content,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      score: row.score,
      snippet: row.snippet,
    }));
  }

  getVersion(repoId: string, axis: AtlasIndexAxis): string | undefined {
    return this.getMetadata(repoId, axis)?.version;
  }

  getMetadata(repoId: string, axis: AtlasIndexAxis): IndexMetadata | undefined {
    const row = this.database
      .prepare(
        `SELECT version, updated_at FROM index_versions
         WHERE repository_id = ? AND axis = ?`,
      )
      .get(repoId, axis) as { version: string; updated_at: string } | undefined;

    return row ? { version: row.version, updatedAt: row.updated_at } : undefined;
  }

  setVersion(repoId: string, axis: AtlasIndexAxis, version: string): void {
    this.ensureRepositoryId(repoId);
    this.setVersionRow(repoId, axis, version, new Date().toISOString());
  }

  getFileCapabilityStates(
    repoId: string,
    capability: AtlasCapability,
  ): Map<string, AtlasFileCapabilityState> {
    const rows = this.database
      .prepare(
         `SELECT c.repository_id, c.file_path, c.file_hash, c.capability,
                c.version, c.state, c.generation, c.item_count,
                c.last_error, c.updated_at
         FROM file_capability_state c
         WHERE c.repository_id = ? AND c.capability = ?`,
      )
      .all(repoId, capability) as CapabilityStateRow[];

    return new Map(rows.map((row) => [row.file_path, this.capabilityStateFromRow(row)]));
  }

  getFileCapabilityState(
    repoId: string,
    file: string,
    capability: AtlasCapability,
  ): AtlasFileCapabilityState | undefined {
    return this.getFileCapabilityStates(repoId, capability).get(file);
  }

  setFileCapabilityState(
    repoId: string,
    file: string,
    capability: AtlasCapability,
    input: FileCapabilityStateInput,
  ): void {
    this.ensureRepositoryId(repoId);
    this.upsertCapabilityState(repoId, file, capability, input);
  }

  deleteFileCapabilityState(
    repoId: string,
    file: string,
    capability: AtlasCapability,
  ): void {
    this.ensureRepositoryId(repoId);
    this.deleteCapabilityState(repoId, file, capability);
    this.deleteOrphanFile(repoId, file);
  }

  private capabilityStateFromRow(row: CapabilityStateRow): AtlasFileCapabilityState {
    return {
      repositoryId: row.repository_id,
      file: row.file_path,
      fileHash: row.file_hash ?? undefined,
      capability: row.capability,
      version: row.version,
      state: row.state,
      generation: row.generation ?? undefined,
      itemCount: row.item_count,
      lastError: row.last_error ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  private upsertFile(file: string, repoId: string, fileHash: string): void {
    this.database
      .prepare(
        `INSERT INTO files
         (repository_id, path, file_hash, indexed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (repository_id, path)
         DO UPDATE SET file_hash = excluded.file_hash, indexed_at = excluded.indexed_at`,
      )
      .run(repoId, file, fileHash, new Date().toISOString());
  }

  private upsertCapabilityState(
    repoId: string,
    file: string,
    capability: AtlasCapability,
    input: FileCapabilityStateInput,
  ): void {
    if (input.fileHash !== undefined) {
      this.upsertFile(file, repoId, input.fileHash);
    }

    this.database
      .prepare(
        `INSERT INTO file_capability_state
         (repository_id, file_path, capability, file_hash, version, state,
          generation, item_count, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, file_path, capability)
         DO UPDATE SET file_hash = excluded.file_hash,
                       version = excluded.version,
                       state = excluded.state,
                       generation = excluded.generation,
                       item_count = excluded.item_count,
                       last_error = excluded.last_error,
                       updated_at = excluded.updated_at`,
      )
      .run(
        repoId,
        file,
        capability,
        input.fileHash ?? null,
        input.version,
        input.state,
        input.generation ?? null,
        input.itemCount,
        input.lastError ?? null,
        new Date().toISOString(),
      );
  }

  private deleteCapabilityStates(repoId: string, capability: AtlasCapability): void {
    this.database
      .prepare(
        "DELETE FROM file_capability_state WHERE repository_id = ? AND capability = ?",
      )
      .run(repoId, capability);
  }

  private deleteCapabilityState(
    repoId: string,
    file: string,
    capability: AtlasCapability,
  ): void {
    this.database
      .prepare(
        `DELETE FROM file_capability_state
         WHERE repository_id = ? AND file_path = ? AND capability = ?`,
      )
      .run(repoId, file, capability);
  }

  private deleteLexicalFile(repoId: string, file: string): void {
    this.database
      .prepare(
        "DELETE FROM lexical_documents WHERE repository_id = ? AND file = ?",
      )
      .run(repoId, file);
  }

  private deleteOrphanFiles(repoId: string): void {
    this.database
      .prepare(
        `DELETE FROM files
         WHERE repository_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM file_capability_state c
             WHERE c.repository_id = files.repository_id
               AND c.file_path = files.path
           )`,
      )
      .run(repoId);
  }

  private deleteOrphanFile(repoId: string, file: string): void {
    this.database
      .prepare(
        `DELETE FROM files
         WHERE repository_id = ? AND path = ?
           AND NOT EXISTS (
             SELECT 1 FROM file_capability_state c
             WHERE c.repository_id = files.repository_id
               AND c.file_path = files.path
           )`,
      )
      .run(repoId, file);
  }

  private setVersionRow(
    repoId: string,
    axis: AtlasIndexAxis,
    version: string,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO index_versions (repository_id, axis, version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (repository_id, axis)
         DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(repoId, axis, version, updatedAt);
  }

  private createInsertNodeStatement() {
    return this.database.prepare(
      `INSERT INTO symbols
       (id, repository_id, type, name, qualified_name, file_path, start_line, end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  private createInsertEdgeStatement() {
    return this.database.prepare(
      `INSERT INTO edges
       (repository_id, owner_file, from_symbol_id, to_symbol_id, type)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  private insertNode(
    statement: ReturnType<DatabaseSync["prepare"]>,
    repoId: string,
    node: GraphNode,
  ): void {
    statement.run(
      node.id,
      repoId,
      node.type,
      node.name,
      node.qualifiedName ?? node.name,
      node.file,
      node.startLine ?? null,
      node.endLine ?? null,
    );
  }

  private insertEdge(
    statement: ReturnType<DatabaseSync["prepare"]>,
    repoId: string,
    ownerFile: string,
    edge: GraphEdge,
  ): void {
    statement.run(repoId, ownerFile, edge.from, edge.to, edge.type);
  }

  close(): void {
    this.database.close();
  }
}

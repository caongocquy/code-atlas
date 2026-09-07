import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { initializeAtlasSchema, ATLAS_SCHEMA_VERSION } from "./atlas.schema.js";
import { decodeFacts, encodeFacts } from "../../core/facts/facts-codec.js";
import { factBlobKey } from "../../core/facts/facts-identity.js";
import type { FactBlobKey, ParsedFactsBlob, ParserIdentity } from "../../core/facts/facts.types.js";
import type {
  AtlasCapability,
  AtlasFileCapabilityState,
  AtlasIndexAxis,
  AtlasRepository,
  AtlasFactBlobRow,
  CapabilityState,
  FileCapabilityStateInput,
  GraphFileState,
  GraphFileUpdate,
  IndexMetadata,
  LexicalFileUpdate,
  LexicalSearchRow,
} from "./atlas.types.js";
import type {
  GraphResolutionFile,
  ResolutionCoverage,
  ResolutionDiagnostic,
} from "../../core/graph/resolution.types.js";
import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode, GraphNodeType } from "../../core/graph/types.js";
import type { RepositoryIdentity } from "../../core/repository/repository-identity.js";
import type { IndexedFileState } from "../../core/repository/indexed-file-state.js";
import type { VectorPoint, VectorSearchResult } from "../../core/semantic/vector-store.js";

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
  provider_identity: string | null;
  item_count: number;
  last_error: string | null;
  updated_at: string;
};

type GraphResolutionFileRow = {
  calls: number;
  resolved_calls: number;
  unresolved_calls: number;
  ambiguous_calls: number;
  extends_count: number;
  resolved_extends: number;
  unresolved_extends: number;
  ambiguous_extends: number;
  parser_errors: number;
  unsupported_dynamic: number;
  may_be_incomplete: number;
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

  constructor(databasePath = DEFAULT_ATLAS_DB_PATH, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly) ensureDatabaseDirectory(databasePath);

    const database = new DatabaseSync(
      options.readOnly ? `${pathToFileURL(path.resolve(databasePath)).href}?immutable=1` : databasePath,
      { readOnly: options.readOnly },
    );

    try {
      if (options.readOnly) {
        this.database = database;
        return;
      }
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA journal_mode = WAL;");
      initializeAtlasSchema(database);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  findRepository(identity: RepositoryIdentity): AtlasRepository | undefined {
    const row = this.database
      .prepare("SELECT * FROM repositories WHERE identity_key = ?")
      .get(identity.identityKey) as RepositoryRow | undefined;
    if (row) return repositoryFromRow(row);
    const byId = this.database
      .prepare("SELECT * FROM repositories WHERE id = ?")
      .get(identity.id) as RepositoryRow | undefined;
    return byId ? repositoryFromRow(byId) : undefined;
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
    resolutionByFile?: Map<string, GraphResolutionFile>,
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
      this.database.prepare("DELETE FROM graph_resolution_files WHERE repository_id = ?").run(repoId);
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
        const resolution = resolutionByFile?.get(file);
        if (resolution) this.upsertGraphResolutionFile(repoId, file, resolution);
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
        this.deleteGraphResolutionFile(repoId, file);
      }

      for (const update of updates) {
        deleteOwnedEdges.run(repoId, update.file);
        deleteNodes.run(repoId, update.file);
        this.deleteCapabilityState(repoId, update.file, "graph");
        this.deleteGraphResolutionFile(repoId, update.file);
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
        if (update.resolution) this.upsertGraphResolutionFile(repoId, update.file, update.resolution);
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
        `SELECT from_symbol_id, to_symbol_id, type,
                resolution_method, evidence_kind, confidence,
                resolution_file, resolution_line
         FROM edges WHERE repository_id = ?`,
      )
      .all(repoId) as Array<{
      from_symbol_id: string;
      to_symbol_id: string;
      type: string;
      resolution_method: string | null;
      evidence_kind: "EXTRACTED" | "INFERRED" | "AMBIGUOUS" | null;
      confidence: number | null;
      resolution_file: string | null;
      resolution_line: number | null;
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
        ...(row.resolution_method ? { resolutionMethod: row.resolution_method as GraphEdge["resolutionMethod"] } : {}),
        ...(row.evidence_kind ? { evidenceKind: row.evidence_kind } : {}),
        ...(row.confidence !== null ? { confidence: row.confidence } : {}),
        ...(row.resolution_file && row.resolution_line !== null
          ? { resolutionSource: { file: row.resolution_file, line: row.resolution_line } }
          : {}),
      })),
    };
  }

  getGraphResolutionCoverage(repoId: string): ResolutionCoverage {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(calls), 0) calls,
                COALESCE(SUM(resolved_calls), 0) resolved_calls,
                COALESCE(SUM(unresolved_calls), 0) unresolved_calls,
                COALESCE(SUM(ambiguous_calls), 0) ambiguous_calls,
                COALESCE(SUM(extends_count), 0) extends_count,
                COALESCE(SUM(resolved_extends), 0) resolved_extends,
                COALESCE(SUM(unresolved_extends), 0) unresolved_extends,
                COALESCE(SUM(ambiguous_extends), 0) ambiguous_extends,
                COALESCE(SUM(parser_errors), 0) parser_errors,
                COALESCE(SUM(unsupported_dynamic), 0) unsupported_dynamic,
                MAX(may_be_incomplete) may_be_incomplete
         FROM graph_resolution_files WHERE repository_id = ?`,
      )
      .get(repoId) as GraphResolutionFileRow;
    return {
      calls: row.calls,
      resolvedCalls: row.resolved_calls,
      unresolvedCalls: row.unresolved_calls,
      ambiguousCalls: row.ambiguous_calls,
      extends: row.extends_count,
      resolvedExtends: row.resolved_extends,
      unresolvedExtends: row.unresolved_extends,
      ambiguousExtends: row.ambiguous_extends,
      parserErrors: row.parser_errors,
      unsupportedDynamic: row.unsupported_dynamic,
      mayBeIncomplete: row.may_be_incomplete === 1,
    };
  }

  getGraphResolutionDiagnostics(repoId: string): ResolutionDiagnostic[] {
    const rows = this.database
      .prepare(
        `SELECT diagnostics_json
         FROM graph_resolution_files
         WHERE repository_id = ?
         ORDER BY file_path ASC`,
      )
      .all(repoId) as Array<{ diagnostics_json: string }>;
    return rows.flatMap((row) => JSON.parse(row.diagnostics_json) as ResolutionDiagnostic[]);
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

  ensureSemanticVectorDimensions(dimensions: number): void {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("Vector dimensions must be a positive integer");
    }

    const row = this.database
      .prepare("SELECT dimensions FROM semantic_vector_config WHERE id = 1")
      .get() as { dimensions: number } | undefined;

    if (row && row.dimensions !== dimensions) {
      throw new Error(
        `Vector dimensions changed from ${row.dimensions} to ${dimensions}`,
      );
    }

    if (!row) {
      this.database
        .prepare("INSERT INTO semantic_vector_config (id, dimensions) VALUES (1, ?)")
        .run(dimensions);
    }
  }

  searchSemanticVectors(
    repoId: string,
    vector: number[],
    limit: number,
  ): VectorSearchResult[] {
    if (limit <= 0 || vector.length === 0) {
      return [];
    }

    const queryNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

    if (queryNorm === 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `SELECT point_id, vector, payload_json
         FROM semantic_vectors
         WHERE repository_id = ?`,
      )
      .all(repoId) as Array<{
      point_id: string;
      vector: Uint8Array;
      payload_json: string;
    }>;
    const results: Array<VectorSearchResult & { pointId: string }> = [];

    // ponytail: O(n) scan keeps the built-in backend dependency-free; replace behind VectorStore if repository scale requires ANN.
    for (const row of rows) {
      const candidate = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );

      if (candidate.length !== vector.length) {
        continue;
      }

      let dot = 0;
      let candidateNormSquared = 0;

      for (let index = 0; index < vector.length; index += 1) {
        const value = candidate[index] ?? 0;
        dot += (vector[index] ?? 0) * value;
        candidateNormSquared += value * value;
      }

      if (candidateNormSquared === 0) {
        continue;
      }

      results.push({
        pointId: row.point_id,
        score: dot / (queryNorm * Math.sqrt(candidateNormSquared)),
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      });
    }

    return results
      .sort((left, right) => right.score - left.score || left.pointId.localeCompare(right.pointId))
      .slice(0, limit)
      .map(({ pointId: _pointId, ...result }) => result);
  }

  countSemanticVectors(repoId: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS count FROM semantic_vectors WHERE repository_id = ?")
      .get(repoId) as { count: number };

    return row.count;
  }

  getSemanticIndexedFileStates(repoId: string): Map<string, IndexedFileState> {
    const rows = this.database
      .prepare(
        `SELECT point_id, file_path, file_hash
         FROM semantic_vectors
         WHERE repository_id = ?
         ORDER BY file_path ASC, point_id ASC`,
      )
      .all(repoId) as Array<{
      point_id: string;
      file_path: string;
      file_hash: string;
    }>;
    const states = new Map<string, IndexedFileState>();

    for (const row of rows) {
      const existing = states.get(row.file_path);

      if (existing) {
        existing.pointIds.push(row.point_id);
      } else {
        states.set(row.file_path, {
          fileHash: row.file_hash,
          pointIds: [row.point_id],
        });
      }
    }

    return states;
  }

  upsertSemanticVectors(points: VectorPoint[]): void {
    if (points.length === 0) {
      return;
    }

    const config = this.database
      .prepare("SELECT dimensions FROM semantic_vector_config WHERE id = 1")
      .get() as { dimensions: number } | undefined;

    if (!config) {
      throw new Error("Vector dimensions must be configured before upsert");
    }

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      const statement = this.database.prepare(
        `INSERT INTO semantic_vectors
         (repository_id, point_id, vector, file_path, file_hash, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, point_id)
         DO UPDATE SET vector = excluded.vector,
                       file_path = excluded.file_path,
                       file_hash = excluded.file_hash,
                       payload_json = excluded.payload_json`,
      );

      for (const point of points) {
        const repositoryId = point.payload.repoId;
        const file = point.payload.file;
        const fileHash = point.payload.fileHash;

        if (
          typeof repositoryId !== "string" ||
          typeof file !== "string" ||
          typeof fileHash !== "string"
        ) {
          throw new Error("Semantic vector payload must include repoId, file, and fileHash");
        }

        if (point.vector.length !== config.dimensions) {
          throw new Error(
            `Vector dimensions mismatch: expected ${config.dimensions}, received ${point.vector.length}`,
          );
        }

        const vector = Float32Array.from(point.vector);
        statement.run(
          repositoryId,
          String(point.id),
          Buffer.from(vector.buffer),
          file,
          fileHash,
          JSON.stringify(point.payload),
        );
      }

      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  deleteSemanticVectorIds(pointIds: Array<string | number>): void {
    if (pointIds.length === 0) {
      return;
    }

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      const placeholders = pointIds.map(() => "?").join(", ");
      this.database
        .prepare(`DELETE FROM semantic_vectors WHERE point_id IN (${placeholders})`)
        .run(...pointIds.map(String));
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  deleteSemanticFile(repoId: string, file: string): void {
    this.database
      .prepare("DELETE FROM semantic_vectors WHERE repository_id = ? AND file_path = ?")
      .run(repoId, file);
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
                c.version, c.state, c.generation, c.provider_identity, c.item_count,
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

  getFactBlob(key: FactBlobKey): string | undefined {
    const row = this.database
      .prepare("SELECT * FROM fact_blobs WHERE fact_blob_key = ?")
      .get(key) as AtlasFactBlobRow | undefined;
    if (!row) return undefined;

    try {
      const lookup = decodeFacts(row.payload_json, {
        key: row.fact_blob_key,
        contentHash: row.content_hash,
        language: row.language,
        parserIdentity: JSON.parse(row.parser_identity_json) as ParserIdentity,
        factsVersion: row.facts_version,
        factsSchemaVersion: row.facts_schema_version,
      });
      return lookup.kind === "hit" ? row.payload_json : undefined;
    } catch {
      return undefined;
    }
  }

  putFactBlob(key: FactBlobKey, facts: ParsedFactsBlob): void {
    if (factBlobKey(facts) !== key) {
      throw new Error("Fact blob key does not match facts provenance");
    }

    const payload = encodeFacts(facts);
    const parserIdentity = JSON.stringify(facts.parserIdentity);
    const existing = this.database
      .prepare("SELECT * FROM fact_blobs WHERE fact_blob_key = ?")
      .get(key) as AtlasFactBlobRow | undefined;

    if (existing) {
      let valid = false;
      try {
        valid = decodeFacts(existing.payload_json, {
          key: existing.fact_blob_key,
          contentHash: existing.content_hash,
          language: existing.language,
          parserIdentity: JSON.parse(existing.parser_identity_json) as ParserIdentity,
          factsVersion: existing.facts_version,
          factsSchemaVersion: existing.facts_schema_version,
        }).kind === "hit";
      } catch {
        valid = false;
      }
      if (valid) return;
    }

    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database
        .prepare(
          `INSERT INTO fact_blobs
           (fact_blob_key, content_hash, language, parser_identity_json,
            facts_version, facts_schema_version, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fact_blob_key) DO UPDATE SET
             content_hash = excluded.content_hash,
             language = excluded.language,
             parser_identity_json = excluded.parser_identity_json,
             facts_version = excluded.facts_version,
             facts_schema_version = excluded.facts_schema_version,
             payload_json = excluded.payload_json`,
        )
        .run(
          key,
          facts.contentHash,
          facts.language,
          parserIdentity,
          facts.factsVersion,
          facts.factsSchemaVersion,
          payload,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
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
      providerIdentity: row.provider_identity ?? undefined,
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
          generation, provider_identity, item_count, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, file_path, capability)
         DO UPDATE SET file_hash = excluded.file_hash,
                       version = excluded.version,
                       state = excluded.state,
                       generation = excluded.generation,
                       provider_identity = excluded.provider_identity,
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
        input.providerIdentity ?? null,
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
       (repository_id, owner_file, from_symbol_id, to_symbol_id, type,
        resolution_method, evidence_kind, confidence, resolution_file,
        resolution_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    statement.run(
      repoId,
      ownerFile,
      edge.from,
      edge.to,
      edge.type,
      edge.resolutionMethod ?? null,
      edge.evidenceKind ?? null,
      edge.confidence ?? null,
      edge.resolutionSource?.file ?? null,
      edge.resolutionSource?.line ?? null,
    );
  }

  private upsertGraphResolutionFile(
    repoId: string,
    file: string,
    resolution: GraphResolutionFile,
  ): void {
    const coverage = resolution.coverage;
    const diagnostics = resolution.diagnostics.map((diagnostic) =>
      diagnostic.kind === "ambiguous"
        ? {
            kind: diagnostic.kind,
            candidates: [...diagnostic.candidates].sort(),
            ambiguityReason: diagnostic.ambiguityReason,
            source: diagnostic.source,
          }
        : {
            kind: diagnostic.kind,
            reason: diagnostic.reason,
            source: diagnostic.source,
            unsupportedDynamic: diagnostic.unsupportedDynamic ?? false,
          },
    );
    this.database
      .prepare(
        `INSERT INTO graph_resolution_files
         (repository_id, file_path, calls, resolved_calls, unresolved_calls,
          ambiguous_calls, extends_count, resolved_extends, unresolved_extends,
          ambiguous_extends, parser_errors, unsupported_dynamic,
          may_be_incomplete, diagnostics_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, file_path)
         DO UPDATE SET calls = excluded.calls,
                       resolved_calls = excluded.resolved_calls,
                       unresolved_calls = excluded.unresolved_calls,
                       ambiguous_calls = excluded.ambiguous_calls,
                       extends_count = excluded.extends_count,
                       resolved_extends = excluded.resolved_extends,
                       unresolved_extends = excluded.unresolved_extends,
                       ambiguous_extends = excluded.ambiguous_extends,
                       parser_errors = excluded.parser_errors,
                       unsupported_dynamic = excluded.unsupported_dynamic,
                       may_be_incomplete = excluded.may_be_incomplete,
                       diagnostics_json = excluded.diagnostics_json,
                       updated_at = excluded.updated_at`,
      )
      .run(
        repoId,
        file,
        coverage.calls,
        coverage.resolvedCalls,
        coverage.unresolvedCalls,
        coverage.ambiguousCalls,
        coverage.extends,
        coverage.resolvedExtends,
        coverage.unresolvedExtends,
        coverage.ambiguousExtends,
        coverage.parserErrors,
        coverage.unsupportedDynamic,
        coverage.mayBeIncomplete ? 1 : 0,
        JSON.stringify(diagnostics),
        new Date().toISOString(),
      );
  }

  private deleteGraphResolutionFile(repoId: string, file: string): void {
    this.database
      .prepare("DELETE FROM graph_resolution_files WHERE repository_id = ? AND file_path = ?")
      .run(repoId, file);
  }

  close(): void {
    this.database.close();
  }
}

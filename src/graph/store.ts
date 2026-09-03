import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CodeGraph,
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
} from "./types.js";

export const DEFAULT_GRAPH_DB_PATH = ".code-rag/graph.db";

export type GraphFileState = {
  fileHash: string;
};

export type GraphFileUpdate = {
  file: string;
  fileHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

function ensureDatabaseDirectory(databasePath: string): void {
  const directory = path.dirname(path.resolve(databasePath));

  fs.mkdirSync(directory, {
    recursive: true,
  });
}

export class GraphStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = DEFAULT_GRAPH_DB_PATH) {
    ensureDatabaseDirectory(databasePath);

    this.database = new DatabaseSync(databasePath);

    this.database.exec("PRAGMA foreign_keys = ON;");

    this.database.exec("PRAGMA journal_mode = WAL;");

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT,
        file TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,

        PRIMARY KEY (
          repo_id,
          id
        )
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        repo_id TEXT NOT NULL,
        owner_file TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,

        PRIMARY KEY (
          repo_id,
          owner_file,
          from_id,
          to_id,
          type
        )
      );

      CREATE TABLE IF NOT EXISTS graph_files (
        repo_id TEXT NOT NULL,
        file TEXT NOT NULL,
        file_hash TEXT NOT NULL,

        PRIMARY KEY (
          repo_id,
          file
        )
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_repo_file
        ON graph_nodes (
          repo_id,
          file
        );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_repo_name
        ON graph_nodes (
          repo_id,
          name
        );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_repo_qualified_name
        ON graph_nodes (
          repo_id,
          qualified_name
        );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_repo_owner
        ON graph_edges (
          repo_id,
          owner_file
        );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_repo_from
        ON graph_edges (
          repo_id,
          from_id,
          type
        );

      CREATE INDEX IF NOT EXISTS idx_graph_edges_repo_to
        ON graph_edges (
          repo_id,
          to_id,
          type
        );

      CREATE INDEX IF NOT EXISTS idx_graph_files_repo
        ON graph_files (
          repo_id
        );
    `);
  }

  getFileStates(repoId: string): Map<string, GraphFileState> {
    const rows = this.database
      .prepare(
        `
          SELECT
            file,
            file_hash
          FROM graph_files
          WHERE repo_id = ?
        `,
      )
      .all(repoId) as Array<{
      file: string;
      file_hash: string;
    }>;

    return new Map(
      rows.map((row) => [
        row.file,
        {
          fileHash: row.file_hash,
        },
      ]),
    );
  }

  replaceGraph(
    repoId: string,
    graph: CodeGraph,
    fileHashes: Map<string, string>,
  ): void {
    const deleteEdges = this.database.prepare(`
      DELETE FROM graph_edges
      WHERE repo_id = ?
    `);

    const deleteNodes = this.database.prepare(`
      DELETE FROM graph_nodes
      WHERE repo_id = ?
    `);

    const deleteFiles = this.database.prepare(`
      DELETE FROM graph_files
      WHERE repo_id = ?
    `);

    const insertNode = this.createInsertNodeStatement();

    const insertEdge = this.createInsertEdgeStatement();

    const insertFileState = this.database.prepare(`
      INSERT INTO graph_files (
        repo_id,
        file,
        file_hash
      )
      VALUES (?, ?, ?)
    `);

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      //
      // Full rebuild means the old graph must
      // disappear completely before new data is written.
      //

      deleteEdges.run(repoId);

      deleteNodes.run(repoId);

      deleteFiles.run(repoId);

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
        insertFileState.run(repoId, file, fileHash);
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
  ): void {
    const deleteOwnedEdges = this.database.prepare(`
        DELETE FROM graph_edges
        WHERE
          repo_id = ?
          AND owner_file = ?
      `);

    const deleteNodes = this.database.prepare(`
        DELETE FROM graph_nodes
        WHERE
          repo_id = ?
          AND file = ?
      `);

    const deleteFileState = this.database.prepare(`
        DELETE FROM graph_files
        WHERE
          repo_id = ?
          AND file = ?
      `);

    const upsertFileState = this.database.prepare(`
        INSERT INTO graph_files (
          repo_id,
          file,
          file_hash
        )
        VALUES (?, ?, ?)
        ON CONFLICT (
          repo_id,
          file
        )
        DO UPDATE SET
          file_hash =
            excluded.file_hash
      `);

    const insertNode = this.createInsertNodeStatement();

    const insertEdge = this.createInsertEdgeStatement();

    this.database.exec("BEGIN IMMEDIATE;");

    try {
      for (const file of deletedFiles) {
        deleteOwnedEdges.run(repoId, file);

        deleteNodes.run(repoId, file);

        deleteFileState.run(repoId, file);
      }

      for (const update of updates) {
        deleteOwnedEdges.run(repoId, update.file);

        deleteNodes.run(repoId, update.file);

        for (const node of update.nodes) {
          this.insertNode(insertNode, repoId, node);
        }

        for (const edge of update.edges) {
          this.insertEdge(insertEdge, repoId, update.file, edge);
        }

        upsertFileState.run(repoId, update.file, update.fileHash);
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
        `
          SELECT
            id,
            type,
            name,
            qualified_name,
            file,
            start_line,
            end_line
          FROM graph_nodes
          WHERE repo_id = ?
        `,
      )
      .all(repoId) as Array<{
      id: string;
      type: string;
      name: string;
      qualified_name: string | null;
      file: string;
      start_line: number | null;
      end_line: number | null;
    }>;

    const edgeRows = this.database
      .prepare(
        `
          SELECT
            from_id,
            to_id,
            type
          FROM graph_edges
          WHERE repo_id = ?
        `,
      )
      .all(repoId) as Array<{
      from_id: string;
      to_id: string;
      type: string;
    }>;

    const nodes: GraphNode[] = nodeRows.map((row) => ({
      id: row.id,
      type: row.type as GraphNodeType,
      name: row.name,
      qualifiedName: row.qualified_name ?? undefined,
      file: row.file,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
    }));

    const edges: GraphEdge[] = edgeRows.map((row) => ({
      from: row.from_id,
      to: row.to_id,
      type: row.type as GraphEdgeType,
    }));

    return {
      nodes,
      edges,
    };
  }

  private createInsertNodeStatement() {
    return this.database.prepare(`
      INSERT INTO graph_nodes (
        id,
        repo_id,
        type,
        name,
        qualified_name,
        file,
        start_line,
        end_line
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `);
  }

  private createInsertEdgeStatement() {
    return this.database.prepare(`
      INSERT INTO graph_edges (
        repo_id,
        owner_file,
        from_id,
        to_id,
        type
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `);
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

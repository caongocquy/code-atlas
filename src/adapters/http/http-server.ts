import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import {
  getGraphOverview,
  getIndexedGraphFiles,
  getGraphNeighborhood,
  getGraphNodeDetails,
  searchGraphNodes,
} from "../../core/graph/explorer.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { createDefaultProviders } from "../../infrastructure/provider-defaults.js";
import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { readIndexedRepoSource } from "./repository-source-path.js";
import {
  inspectRetrieval,
  type RetrievalInspectOptions,
} from "../../core/retrieval/retrieval-inspector.service.js";

const app = Fastify({ logger: true });
const repoPath = path.resolve(process.env.CODE_RAG_REPO_PATH ?? process.cwd());
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const uiRoot = path.join(packageRoot, "dist", "ui");
const defaultProviders = createDefaultProviders(repoPath);
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameFromAuthority(authority: string): string | undefined {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

const bindHost = process.env.CODE_ATLAS_HTTP_HOST ?? "127.0.0.1";
const localBinding = localHostnames.has(bindHost.toLowerCase());
const allowedHostnames = new Set(
  localBinding
    ? localHostnames
    : (process.env.CODE_ATLAS_HTTP_ALLOWED_HOSTS ?? "").split(",")
      .map((host) => hostnameFromAuthority(host.trim()))
      .filter((host): host is string => host !== undefined),
);

app.addHook("onRequest", async (request, reply) => {
  const hostHeader = request.headers.host;
  const hostname = hostHeader ? hostnameFromAuthority(hostHeader) : undefined;
  if (!hostname || !allowedHostnames.has(hostname)) {
    return reply.code(403).send({ error: "Host is not allowed" });
  }

  const origin = request.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!hostHeader || parsed.host.toLowerCase() !== hostHeader.toLowerCase()
        || !allowedHostnames.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""))
        || parsed.protocol !== `${request.protocol}:`) {
        return reply.code(403).send({ error: "Cross-origin requests are not allowed" });
      }
    } catch {
      return reply.code(403).send({ error: "Cross-origin requests are not allowed" });
    }
  }
});

async function loadGraph() {
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));

  try {
    const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
    if (store.getFileStates(repoId).size === 0) {
      throw new Error(`No persisted graph found for repo "${repoId}".`);
    }
    return store.loadGraph(repoId);
  } finally {
    store.close();
  }
}

function requestError(error: unknown): { error: string } {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sourceLanguage(file: string): string {
  const extension = path.extname(file).toLowerCase();

  return {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
  }[extension] ?? "plaintext";
}

app.get("/health", async () => ({
  api: "ok",
  vectorStore: defaultProviders.vectorStore.id,
}));

app.get("/api/status", async (_request, reply) => {
  try {
    return await getRepositoryStatus(repoPath, {
      embeddingProvider: defaultProviders.embeddingProvider,
      vectorStore: defaultProviders.vectorStore,
      rerankerProvider: defaultProviders.rerankerProvider,
    });
  } catch (error) {
    return reply.code(500).send(requestError(error));
  }
});

app.get("/api/graph/search", async (request, reply) => {
  const query = (request.query as { q?: string }).q?.trim() ?? "";

  if (!query) {
    return reply.code(400).send({ error: "Query parameter q is required" });
  }

  try {
    const graph = await loadGraph();
    return { query, nodes: searchGraphNodes(graph, query) };
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.get("/api/graph/overview", async (_request, reply) => {
  try {
    const graph = await loadGraph();
    return getGraphOverview(graph);
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.get("/api/files", async (_request, reply) => {
  try {
    const graph = await loadGraph();
    return { files: getIndexedGraphFiles(graph) };
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.get("/api/graph/node/:id", async (request, reply) => {
  try {
    const graph = await loadGraph();
    const nodeId = (request.params as { id: string }).id;
    const details = getGraphNodeDetails(graph, nodeId);

    if (!details) {
      return reply.code(404).send({ error: "Graph node not found" });
    }

    return details;
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.get("/api/graph/neighbors/:id", async (request, reply) => {
  try {
    const query = request.query as {
      depth?: string;
      maxNodes?: string;
      edgeTypes?: string;
    };
    const graph = await loadGraph();
    const edgeTypes = query.edgeTypes
      ?.split(",")
      .filter((type): type is "calls" | "imports" | "extends" | "implements" | "references" | "contains" =>
        ["calls", "imports", "extends", "implements", "references", "contains"].includes(type),
      );

    return getGraphNeighborhood(
      graph,
      (request.params as { id: string }).id,
      {
        depth: numberParam(query.depth, 1),
        maxNodes: numberParam(query.maxNodes, 80),
        edgeTypes: edgeTypes?.length ? edgeTypes : undefined,
      },
    );
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.get("/api/source", async (request, reply) => {
  const query = request.query as {
    path?: string;
    startLine?: string;
    endLine?: string;
  };

  if (!query.path) {
    return reply.code(400).send({ error: "Query parameter path is required" });
  }

  let content: string;
  try {
    const graph = await loadGraph();
    const indexedPaths = new Set(getIndexedGraphFiles(graph).map((file) => file.path));
    content = await readIndexedRepoSource(repoPath, query.path, indexedPaths);
  } catch (error) {
    const statusCode = error instanceof Error && /not indexed|Sensitive|Ignored|Symbolic|nested repositories|regular file|changed while/i.test(error.message)
      ? 403
      : 404;
    return reply.code(statusCode).send(requestError(error));
  }

  try {
    const lines = content.split(/\r?\n/);
    const hasRange = query.startLine !== undefined || query.endLine !== undefined;
    const startLine = hasRange ? Math.max(1, Math.floor(numberParam(query.startLine, 1))) : 1;
    const endLine = hasRange
      ? Math.min(lines.length, Math.max(startLine, Math.floor(numberParam(query.endLine, startLine + 80))))
      : lines.length;

    return {
      path: query.path,
      language: sourceLanguage(query.path),
      startLine,
      endLine,
      content: lines.slice(startLine - 1, endLine).join("\n"),
    };
  } catch (error) {
    return reply.code(404).send(requestError(error));
  }
});

app.post("/api/retrieval/inspect", async (request, reply) => {
  const body = request.body as RetrievalInspectOptions & { query?: unknown };
  const query = typeof body?.query === "string" ? body.query : "";

  try {
    return await inspectRetrieval(query, {
      ...body,
      repoPath,
      providers: defaultProviders,
    });
  } catch (error) {
    return reply.code(400).send(requestError(error));
  }
});

app.register(fastifyStatic, {
  root: uiRoot,
  prefix: "/",
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/") || request.url === "/health") {
    return reply.code(404).send({ error: "Not found" });
  }

  try {
    await fs.access(path.join(uiRoot, "index.html"));
    return reply.sendFile("index.html", uiRoot);
  } catch {
    return reply.code(404).send({
      error: "Inspector UI is not built. Run pnpm build first.",
    });
  }
});

const start = async (): Promise<void> => {
  try {
    if (!localBinding && allowedHostnames.size === 0) {
      throw new Error("External HTTP binding requires CODE_ATLAS_HTTP_ALLOWED_HOSTS");
    }
    await app.listen({
      port: Number(process.env.PORT ?? 3000),
      host: bindHost,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();

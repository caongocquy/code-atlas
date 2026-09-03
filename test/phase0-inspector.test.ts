import test from "node:test";
import assert from "node:assert/strict";

import { expandGraphContextDetailed } from "../src/graph/expand.js";
import type { InspectorChunk, RetrievalInspection } from "../src/services/retrieval-inspector.js";
import { buildContext } from "../src/utils/context.js";
import { buildCodebaseMessages } from "../src/utils/prompt.js";

function chunk(file: string, symbolName: string, source: InspectorChunk["source"]): InspectorChunk {
  return {
    score: 0.5,
    file,
    symbolName,
    symbolType: "function",
    startLine: 1,
    endLine: 1,
    content: `${symbolName}()`,
    key: `${file}:${symbolName}`,
    source,
    provenance: [{ source, stage: source === "graph" ? "graph" : source }],
  };
}

test("Inspector preserves stage shapes and graph expansion provenance", () => {
  const seed = chunk("src/a.ts", "run", "lexical");
  const graph = {
    nodes: [
      { id: "run", type: "function" as const, name: "run", file: "src/a.ts" },
      { id: "helper", type: "function" as const, name: "helper", file: "src/b.ts" },
    ],
    edges: [{ from: "run", to: "helper", type: "calls" as const }],
  };
  const expansion = expandGraphContextDetailed(
    graph,
    [{ file: "src/a.ts", symbolName: "run", symbolType: "function" }],
    { maxDepth: 1, maxNodes: 1 },
  );

  assert.deepEqual(expansion.details.map((detail) => ({
    relation: detail.relation,
    depth: detail.depth,
    seedNode: detail.seedNodeId,
    path: detail.path,
  })), [{ relation: "calls", depth: 1, seedNode: "run", path: ["run", "helper"] }]);

  const inspectionShape = {
    vectorResults: [chunk("src/a.ts", "run", "vector")],
    lexicalResults: [seed],
    fusedResults: [seed],
    rerankedResults: [seed],
    graphExpansion: { available: true, details: expansion.details },
    retrievalOnly: { rendered: buildContext([seed]) },
    withGraph: { rendered: buildContext([seed, chunk("src/b.ts", "helper", "graph")]) },
  } satisfies Partial<RetrievalInspection>;

  assert.deepEqual(Object.keys(inspectionShape), [
    "vectorResults",
    "lexicalResults",
    "fusedResults",
    "rerankedResults",
    "graphExpansion",
    "retrievalOnly",
    "withGraph",
  ]);
  assert.notEqual(
    inspectionShape.retrievalOnly?.rendered,
    inspectionShape.withGraph?.rendered,
  );
});

test("Inspector final context is exactly the context sent in LLM messages", () => {
  const finalContext = buildContext([chunk("src/a.ts", "run", "lexical")]);
  const messages = buildCodebaseMessages("where is run?", finalContext);

  assert.equal(messages[1]?.content.endsWith(finalContext), true);
});

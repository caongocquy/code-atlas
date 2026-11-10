import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-imports-"));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  return root;
}
function calls(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const graph = store.loadGraph(getRepositoryIdentity(root).id);
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges.filter((edge) => edge.type === "calls").map((edge) => ({
      from: nodes.get(edge.from)?.name,
      to: nodes.get(edge.to)?.name,
      targetFile: nodes.get(edge.to)?.file,
      strategy: edge.resolution?.strategy,
      evidence: edge.resolution?.evidence.map((item) => item.sourceUnit),
    }));
  } finally { store.close(); }
}
const service = "export function getUser() { return 123; }\n";
const caller = (module: string, imported = "fetchUser") =>
  `import { ${imported} } from "${module}";\nexport function Home() { return ${imported}(); }\n`;

test("CA-02 resolves direct named import and barrel re-exports to exact source symbol", async () => {
  for (const [label, files] of [
    ["direct", {
      "src/user.ts": service,
      "src/Home.ts": 'import { getUser as fetchUser } from "./user.js";\nexport function Home() { return fetchUser(); }\n',
    }],
    ["barrel", {
      "src/user.ts": service,
      "src/index.ts": 'export { getUser as fetchUser } from "./user.js";\n',
      "src/Home.ts": caller("./index.js"),
    }],
    ["two barrels", {
      "src/user.ts": service,
      "src/middle.ts": 'export { getUser as loadUser } from "./user.js";\n',
      "src/index.ts": 'export { loadUser as fetchUser } from "./middle.js";\n',
      "src/Home.ts": caller("./index.js"),
    }],
    ["reexport of an imported binding", {
      "src/user.ts": service,
      "src/index.ts": 'import { getUser as loadUser } from "./user.js"; export { loadUser as fetchUser };\n',
      "src/Home.ts": caller("./index.js"),
    }],
    ["default function export", {
      "src/user.ts": "export default function getUser() { return 123; }\n",
      "src/Home.ts": 'import fetchUser from "./user.js";\nexport function Home() { return fetchUser(); }\n',
    }],
    ["same-name decoy in unrelated module", {
      "src/user.ts": service,
      "src/unrelated.ts": service,
      "src/Home.ts": 'import { getUser as fetchUser } from "./user.js";\nexport function Home() { return fetchUser(); }\n',
    }],
  ] as const) {
    const root = await repo(files);
    try {
      const published = await indexRepository(root, { skipGit: true });
      assert.equal(published.kind, "published", label);
      const edges = calls(root);
      assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.targetFile, edge.strategy]),
        [["Home", "getUser", "src/user.ts", "imports-exports"]], label + ": " + JSON.stringify(edges));
      assert.ok(edges[0]?.evidence?.includes("src/Home.ts"), label);
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("CA-02 keeps missing, external, shadowed and ambiguous imports unresolved", async () => {
  for (const [label, files] of [
    ["external", { "Home.ts": 'import { fetchUser } from "external-sdk"; export function Home() { fetchUser(); }' }],
    ["missing file", { "Home.ts": caller("./missing.js") }],
    ["local shadow", {
      "user.ts": 'export function fetchUser() {}',
      "Home.ts": 'import { fetchUser } from "./user"; export function Home(fetchUser: () => void) { fetchUser(); }',
    }],
    ["ambiguous path", {
      "pkg.ts": 'export function fetchUser() {}',
      "pkg/index.ts": 'export function fetchUser() {}',
      "Home.ts": caller("./pkg"),
    }],
    ["ambiguous barrel", {
      "a.ts": "export function fetchUser() {}",
      "b.ts": "export function fetchUser() {}",
      "index.ts": 'export * from "./a"; export * from "./b";',
      "Home.ts": caller("./index"),
    }],
    ["cycle", {
      "a.ts": 'export { fetchUser } from "./b";',
      "b.ts": 'export { fetchUser } from "./a";',
      "Home.ts": caller("./a"),
    }],
  ] as const) {
    const root = await repo(files);
    try {
      assert.equal((await indexRepository(root, { skipGit: true })).kind, "published", label);
      assert.deepEqual(calls(root), [], label);
    } finally { await rm(root, { force: true, recursive: true }); }
  }
});

test("CA-02 import edges agree after clean and incremental rebuild", async () => {
  const files = {
    "user.ts": "export function getUser() {}",
    "index.ts": 'export { getUser as fetchUser } from "./user";',
    "Home.ts": caller("./index"),
  };
  const root = await repo(files);
  const cleanRoot = await repo(files);
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(cleanRoot, { skipGit: true })).kind, "published");
    const baseline = calls(cleanRoot);
    assert.deepEqual(calls(root), baseline);
    await writeFile(path.join(root, "Home.ts"), caller("./index") + "\n// unrelated edit\n");
    assert.equal((await syncRepository(root, { skipGit: true })).kind, "published");
    assert.deepEqual(calls(root), baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cleanRoot, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForServer(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`HTTP test server exited with ${child.exitCode}`);
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error("HTTP test server did not start");
}

test("HTTP source endpoint rejects secrets, ignored and symlinked files and rebinding origins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-http-security-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "code-atlas-http-outside-"));
  const port = await freePort();
  const sourceFiles = ["src/index.ts", "ignored.ts", ".env", "credentials.json", "src/escape.ts", "src/linked/secret.ts"];
  let child: ChildProcess | undefined;

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".codeatlas"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(root, "src/index.ts"), "export const visible = true;\n");
    await writeFile(path.join(root, "ignored.ts"), "ignored marker\n");
    await writeFile(path.join(root, ".env"), "SECRET=must-not-leak\n");
    await writeFile(path.join(root, "credentials.json"), '{"token":"credential-must-not-leak"}\n');
    await writeFile(path.join(root, "unindexed.ts"), "unindexed marker\n");
    await writeFile(path.join(outside, "secret.ts"), "outside marker\n");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src/escape.ts"));
    await symlink(outside, path.join(root, "src/linked"), process.platform === "win32" ? "junction" : "dir");

    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(root));
    store.replaceGraph(repository.id, {
      nodes: sourceFiles.map((file) => ({ id: `file:${file}`, type: "file" as const, name: file, file })),
      edges: [],
    }, new Map(sourceFiles.map((file) => [file, "test-hash"])));
    store.close();

    child = spawn(process.execPath, ["--import", "tsx/esm", "src/adapters/http/http-server.ts"], {
      cwd: path.resolve("."),
      env: { ...process.env, CODE_RAG_REPO_PATH: root, PORT: String(port), CODE_ATLAS_HTTP_HOST: "127.0.0.1" },
      stdio: "ignore",
    });
    await waitForServer(port, child);

    const base = `http://127.0.0.1:${port}`;
    const visible = await fetch(`${base}/api/source?path=src%2Findex.ts`);
    assert.equal(visible.status, 200);
    assert.match(await visible.text(), /visible/);

    for (const requestPath of [".env", "credentials.json", "ignored.ts", "src/escape.ts", "src/linked/secret.ts", "unindexed.ts"]) {
      const response = await fetch(`${base}/api/source?path=${encodeURIComponent(requestPath)}`);
      assert.notEqual(response.status, 200, `${requestPath} must not be returned`);
      assert.doesNotMatch(await response.text(), /must-not-leak|credential-must-not-leak|outside marker|ignored marker|unindexed marker/);
    }

    const escapingPath = path.join(root, "src/escape.ts");
    const replaceSymlink = async (): Promise<void> => {
      for (let index = 0; index < 20; index += 1) {
        await rm(escapingPath, { force: true });
        await symlink(path.join(outside, "secret.ts"), escapingPath);
        await delay(1);
        await rm(escapingPath, { force: true });
        await writeFile(escapingPath, "local safe marker\n");
        await delay(1);
      }
    };
    const replacement = replaceSymlink();
    const racedResponses = await Promise.all(Array.from({ length: 20 }, () =>
      fetch(`${base}/api/source?path=src%2Fescape.ts`).then((response) => response.text()),
    ));
    await replacement;
    assert.ok(racedResponses.every((body) => !body.includes("outside marker")));

    const rebinding = await fetch(`${base}/health`, { headers: { host: `attacker.test:${port}`, origin: `http://attacker.test:${port}` } });
    assert.equal(rebinding.status, 403);
    const crossOrigin = await fetch(`${base}/health`, { headers: { origin: `http://attacker.test:${port}` } });
    assert.equal(crossOrigin.status, 403);
    const sameOrigin = await fetch(`${base}/health`, { headers: { origin: base } });
    assert.equal(sameOrigin.status, 200);
  } finally {
    child?.kill();
    if (child) await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

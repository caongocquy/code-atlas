import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { request as namedHttpRequest } from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";
import { promisify } from "node:util";

import { execFile, installOfflineGuard } from "../eval/context/offline-guard.js";

const execFileAsync = promisify(execFile);

test("installOfflineGuard blocks evaluator network primitives and Git network commands reversibly", async () => {
  const originalFetch = globalThis.fetch;
  const restore = installOfflineGuard();
  try {
    await assert.rejects(() => globalThis.fetch("https://example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => http.request("http://example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => namedHttpRequest("http://example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => https.request("https://example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => net.connect(443, "example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => net.createConnection(443, "example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => tls.connect(443, "example.com"), /Phase15D offline guard: network access is disabled/);
    assert.throws(() => dns.lookup("example.com", () => undefined), /Phase15D offline guard: network access is disabled/);
    await assert.rejects(() => dns.promises.lookup("example.com"), /Phase15D offline guard: network access is disabled/);
    await assert.rejects(() => execFileAsync("git", ["clone", "https://example.com/repository.git"]), /Phase15D offline guard: git clone is disabled/);
    await assert.rejects(() => execFileAsync("git", ["fetch"]), /Phase15D offline guard: git fetch is disabled/);
    await assert.rejects(() => execFileAsync("git", ["pull"]), /Phase15D offline guard: git pull is disabled/);
    await assert.rejects(() => execFileAsync("git", ["remote"]), /Phase15D offline guard: git remote is disabled/);
  } finally {
    restore();
  }
  assert.equal(globalThis.fetch, originalFetch);
});

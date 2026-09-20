import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
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
const childExecFile = promisify(execFileCallback);

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

test("installOfflineGuard synchronizes named ESM HTTP, HTTPS, and DNS imports", async () => {
  const guardModule = new URL("../eval/context/offline-guard.ts", import.meta.url).href;
  const program = `
    import assert from "node:assert/strict";
    import { lookup as dnsLookup } from "node:dns";
    import { lookup as dnsPromisesLookup } from "node:dns/promises";
    import { request as httpRequest } from "node:http";
    import { request as httpsRequest } from "node:https";
    import { installOfflineGuard } from ${JSON.stringify(guardModule)};

    const restore = installOfflineGuard();
    try {
      assert.throws(() => {
        const request = httpRequest({ hostname: "localhost", port: 9 });
        request.destroy();
      }, /Phase15D offline guard: network access is disabled/);
      assert.throws(() => {
        const request = httpsRequest({ hostname: "localhost", port: 9 });
        request.destroy();
      }, /Phase15D offline guard: network access is disabled/);
      assert.throws(() => dnsLookup("localhost", () => undefined), /Phase15D offline guard: network access is disabled/);
      await assert.rejects(() => dnsPromisesLookup("localhost"), /Phase15D offline guard: network access is disabled/);
    } finally {
      restore();
    }
  `;
  await childExecFile(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", program], { cwd: process.cwd() });
});

test("installOfflineGuard keeps the guard active until the final out-of-order restore", async () => {
  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
  };
  const firstRestore = installOfflineGuard();
  const secondRestore = installOfflineGuard();
  try {
    firstRestore();
    assert.throws(() => dns.lookup("localhost", () => undefined), /Phase15D offline guard: network access is disabled/);
    firstRestore();
  } finally {
    secondRestore();
  }
  assert.equal(globalThis.fetch, originals.fetch);
  assert.equal(http.request, originals.httpRequest);
  assert.equal(https.request, originals.httpsRequest);
  assert.equal(net.connect, originals.netConnect);
  assert.equal(net.createConnection, originals.netCreateConnection);
  assert.equal(tls.connect, originals.tlsConnect);
  assert.equal(dns.lookup, originals.dnsLookup);
  assert.equal(dns.promises.lookup, originals.dnsPromisesLookup);
});

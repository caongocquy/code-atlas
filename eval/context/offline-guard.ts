import { execFile as nodeExecFile } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const blockedGitCommands = new Set(["clone", "fetch", "pull", "remote"]);
let guardDepth = 0;
let originals: {
  fetch: typeof globalThis.fetch;
  httpRequest: typeof http.request;
  httpsRequest: typeof https.request;
  netConnect: typeof net.connect;
  netCreateConnection: typeof net.createConnection;
  tlsConnect: typeof tls.connect;
  dnsLookup: typeof dns.lookup;
  dnsPromisesLookup: typeof dns.promises.lookup;
} | undefined;

function networkError(): Error {
  return new Error("Phase15D offline guard: network access is disabled");
}

function gitError(command: string): Error {
  return new Error(`Phase15D offline guard: git ${command} is disabled`);
}

function blockedNetworkCall(): never {
  throw networkError();
}

function blockedGitCommand(file: string, args: readonly string[]): string | undefined {
  if (path.basename(file) !== "git") return undefined;
  return args.find((arg) => blockedGitCommands.has(arg));
}

export const execFile: typeof nodeExecFile = ((file: string, ...args: unknown[]) => {
  const command = blockedGitCommand(file, Array.isArray(args[0]) ? args[0] : []);
  if (guardDepth > 0 && command) throw gitError(command);
  return Reflect.apply(nodeExecFile, undefined, [file, ...args]);
}) as typeof nodeExecFile;

export function installOfflineGuard(): () => void {
  if (guardDepth === 0) {
    originals = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpsRequest: https.request,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      tlsConnect: tls.connect,
      dnsLookup: dns.lookup,
      dnsPromisesLookup: dns.promises.lookup,
    };
    globalThis.fetch = (async () => blockedNetworkCall()) as typeof globalThis.fetch;
    http.request = blockedNetworkCall as typeof http.request;
    https.request = blockedNetworkCall as typeof https.request;
    net.connect = blockedNetworkCall as typeof net.connect;
    net.createConnection = blockedNetworkCall as typeof net.createConnection;
    tls.connect = blockedNetworkCall as typeof tls.connect;
    dns.lookup = blockedNetworkCall as unknown as typeof dns.lookup;
    dns.promises.lookup = (async () => blockedNetworkCall()) as typeof dns.promises.lookup;
    syncBuiltinESMExports();
  }
  let restored = false;

  guardDepth += 1;

  return () => {
    if (restored) return;
    restored = true;
    guardDepth -= 1;
    if (guardDepth > 0 || !originals) return;
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
    net.connect = originals.netConnect;
    net.createConnection = originals.netCreateConnection;
    tls.connect = originals.tlsConnect;
    dns.lookup = originals.dnsLookup;
    dns.promises.lookup = originals.dnsPromisesLookup;
    originals = undefined;
    syncBuiltinESMExports();
  };
}

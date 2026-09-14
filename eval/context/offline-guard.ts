import { execFile as nodeExecFile } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const blockedGitCommands = new Set(["clone", "fetch", "pull", "remote"]);
let guardDepth = 0;

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
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalTlsConnect = tls.connect;
  const originalDnsLookup = dns.lookup;
  const originalDnsPromisesLookup = dns.promises.lookup;
  let restored = false;

  guardDepth += 1;
  globalThis.fetch = (async () => blockedNetworkCall()) as typeof globalThis.fetch;
  http.request = blockedNetworkCall as typeof http.request;
  https.request = blockedNetworkCall as typeof https.request;
  net.connect = blockedNetworkCall as typeof net.connect;
  net.createConnection = blockedNetworkCall as typeof net.createConnection;
  tls.connect = blockedNetworkCall as typeof tls.connect;
  dns.lookup = blockedNetworkCall as typeof dns.lookup;
  dns.promises.lookup = (async () => blockedNetworkCall()) as typeof dns.promises.lookup;

  return () => {
    if (restored) return;
    restored = true;
    guardDepth -= 1;
    globalThis.fetch = originalFetch;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    net.connect = originalNetConnect;
    net.createConnection = originalNetCreateConnection;
    tls.connect = originalTlsConnect;
    dns.lookup = originalDnsLookup;
    dns.promises.lookup = originalDnsPromisesLookup;
  };
}

import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { parse as parseToml } from "smol-toml";

import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION } from "../src/config/constants.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { scanRepo } from "../src/core/repository/repository-files.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { isInteractiveMcpSession, MCP_INTERACTIVE_NOTICE } from "../src/adapters/mcp/mcp-server.js";
import { isEphemeralCodeAtlasPath, resolveCodeAtlasMcpLaunch } from "../src/infrastructure/integration/codex.adapter.js";
import { createAgentIntegrationService } from "../src/infrastructure/integration/default-integrations.js";
import { installGuidance } from "../src/infrastructure/integration/strict-guidance.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

async function fixture(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-12-${name}-`));
}

async function runCli(repoPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd: repoPath,
    env: {
      ...process.env,
      CODEX_HOME: path.join(repoPath, ".codex-home"),
      XDG_CONFIG_HOME: path.join(repoPath, ".xdg"),
      NO_COLOR: "1",
    },
  });
}

test("scanner prunes ignored and built-in dependency trees before walking", async () => {
  const repoPath = await fixture("scanner");
  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await mkdir(path.join(repoPath, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(repoPath, "voice", ".venv", "lib"), { recursive: true });
    await mkdir(path.join(repoPath, "references", "deepseek-harness", "packages"), { recursive: true });
    await mkdir(path.join(repoPath, "references", "deepseek-harness", ".git"));
    await mkdir(path.join(repoPath, "references", "kept"), { recursive: true });
    await mkdir(path.join(repoPath, "ignored-by-gitignore"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "a.ts"), "export const a = true;\n");
    await writeFile(path.join(repoPath, "src", "b.ts"), "export const b = true;\n");
    await writeFile(path.join(repoPath, "node_modules", "pkg", "fake.ts"), "export const fake = true;\n");
    await writeFile(path.join(repoPath, "voice", ".venv", "lib", "fake.py"), "fake = True\n");
    await writeFile(path.join(repoPath, "references", "deepseek-harness", "packages", "fake.py"), "fake = True\n");
    await writeFile(path.join(repoPath, "references", "kept", "source.ts"), "export const kept = true;\n");
    await writeFile(path.join(repoPath, "ignored-by-gitignore", "fake.ts"), "export const fake = true;\n");
    await writeFile(path.join(repoPath, ".gitignore"), "ignored-by-gitignore/\n");

    const files = (await scanRepo(repoPath)).map((file) => path.relative(repoPath, file));
    assert.deepEqual(files, ["references/kept/source.ts", "src/a.ts", "src/b.ts"]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("CLI index uses human progress and completion output", async () => {
  const repoPath = await fixture("index-output");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, "index");
    assert.match(result.stdout, /Scanning repository/);
    assert.match(result.stdout, /Index complete/);
    assert.doesNotMatch(result.stdout, /"operation"/);

    const json = await runCli(repoPath, "index", "--json");
    assert.doesNotThrow(() => JSON.parse(json.stdout));
    assert.doesNotMatch(json.stdout, /Scanning repository|Index complete/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("default CLI output is human-readable while --json stays machine-readable", async () => {
  const repoPath = await fixture("output");
  try {
    const init = await runCli(repoPath, "init");
    assert.match(init.stdout, /CodeAtlas initialized/);
    assert.doesNotMatch(init.stdout, /^\s*\{/);

    const status = await runCli(repoPath, "status");
    assert.match(status.stdout, /CodeAtlas Status/);
    assert.doesNotMatch(status.stdout, /^\s*\{/);

    const json = await runCli(repoPath, "status", "--json");
    assert.doesNotThrow(() => JSON.parse(json.stdout));
    assert.doesNotMatch(json.stdout, /CodeAtlas Status/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("connect configures Codex and default CodeAtlas guidance", async () => {
  const repoPath = await fixture("connect");
  try {
    const result = await runCli(repoPath, "connect", "codex");
    assert.match(result.stdout, /Connecting CodeAtlas to Codex/);
    assert.match(result.stdout, /Codex is ready to use CodeAtlas/);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    assert.match(guidance, /code-atlas:start/);
    assert.doesNotMatch(guidance, /code-atlas:final-newline/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("generated guidance advertises ready graph tools without making them mandatory", async () => {
  const repoPath = await fixture("guidance-graph");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    await indexRepository(repoPath, { skipGit: true });
    await installGuidance(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    assert.doesNotMatch(guidance, /code-atlas:final-newline/);
    assert.match(guidance, /find_callers/);
    assert.match(guidance, /find_callees/);
    assert.match(guidance, /find_imports/);
    assert.match(guidance, /impact/);
    assert.match(guidance, /trace/);
    assert.match(guidance, /not required for trivial or isolated edits/);
    assert.match(guidance, /repository_status.*freshness/s);
    assert.match(guidance, /search_code.*get_symbol.*precise navigation/s);
    assert.match(guidance, /mayBeIncomplete=true/);
    assert.match(guidance, /risk=unknown/);
    assert.match(guidance, /negative results.*not authoritative/s);
    assert.doesNotMatch(guidance, /MUST|NEVER|strict, opt-in|indexed capabilities:/);
    assert.equal(guidance.match(/<!-- code-atlas:start -->/g)?.length, 1);
    assert.equal(guidance.match(/<!-- code-atlas:end -->/g)?.length, 1);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("generated guidance reports stale capabilities and gives sync recovery", async () => {
  const repoPath = await fixture("guidance-stale");
  try {
    const sourcePath = path.join(repoPath, "source.ts");
    await writeFile(sourcePath, "export function source() { return true; }\n");
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(sourcePath, "export function source() { return false; }\n");
    await installGuidance(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    assert.match(guidance, /- graph: stale/);
    assert.match(guidance, /- lexical: stale/);
    assert.match(guidance, /code-atlas sync/);
    assert.doesNotMatch(guidance, /find_callers|find_callees|find_imports|find_imported_by|`impact`|`trace`/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("generated guidance reports an unavailable graph conservatively", async () => {
  const repoPath = await fixture("guidance-unavailable");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  try {
    const source = "export function source() { return true; }\n";
    await writeFile(path.join(repoPath, "source.ts"), source);
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    store.setFileCapabilityState(repository.id, "source.ts", "graph", {
      fileHash: createFileHash(source),
      version: GRAPH_INDEX_VERSION,
      state: "unavailable",
      itemCount: 0,
    });
    store.setFileCapabilityState(repository.id, "source.ts", "lexical", {
      fileHash: createFileHash(source),
      version: LEXICAL_INDEX_VERSION,
      state: "unavailable",
      itemCount: 0,
    });
    store.close();

    await installGuidance(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    assert.match(guidance, /- graph: unavailable/);
    assert.match(guidance, /- lexical: unavailable/);
    assert.doesNotMatch(guidance, /find_callers|find_callees|find_imports|find_imported_by|`impact`|`trace`/);
    assert.match(guidance, /direct source inspection/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("generated guidance reports a missing index and gives index recovery", async () => {
  const repoPath = await fixture("guidance-not-indexed");
  try {
    await installGuidance(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");
    assert.match(guidance, /- graph: not-indexed/);
    assert.match(guidance, /- lexical: not-indexed/);
    assert.match(guidance, /code-atlas index/);
    assert.doesNotMatch(guidance, /find_callers|find_callees|find_imports|find_imported_by|`impact`|`trace`/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("guidance refresh removes internal newline metadata and preserves the final newline", async () => {
  const repoPath = await fixture("guidance-newline");
  try {
    await writeFile(path.join(repoPath, "AGENTS.md"), [
      "# Local guidance",
      "",
      "<!-- code-atlas:start -->",
      "code-atlas:final-newline=0",
      "old guidance",
      "<!-- code-atlas:end -->",
    ].join("\n"));
    await installGuidance(repoPath);
    const guidancePath = path.join(repoPath, "AGENTS.md");
    const guidance = await readFile(guidancePath, "utf8");
    assert.match(guidance, /^# Local guidance\n/);
    assert.doesNotMatch(guidance, /code-atlas:final-newline|old guidance/);
    assert.equal(guidance.endsWith("\n"), false);
    assert.equal(await installGuidance(repoPath), false);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Codex MCP configuration launches with a minimal PATH and clean JSON-RPC stdout", async () => {
  const repoPath = await fixture("codex-launch");
  try {
    const result = await runCli(repoPath, "connect", "codex", "--no-guidance", "--json");
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    const config = parseToml(await readFile(path.join(repoPath, ".codex-home", "config.toml"), "utf8")) as Record<string, any>;
    const entry = config.mcp_servers["code-atlas"];

    assert.ok(path.isAbsolute(entry.command));
    assert.equal(entry.command, process.execPath);
    assert.equal(entry.args.length, 2);
    assert.ok(path.isAbsolute(entry.args[0]));
    await access(entry.command);
    await access(entry.args[0]);
    assert.equal(entry.args[1], "mcp");
    assert.equal(isEphemeralCodeAtlasPath(entry.args[0]), false);
    assert.equal(entry.cwd, undefined);

    const child = spawn(entry.command, entry.args, {
      cwd: repoPath,
      env: { PATH: "/usr/bin:/bin", HOME: repoPath, CODEX_HOME: path.join(repoPath, ".codex-home") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const response = await new Promise<Record<string, any>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`MCP initialize timed out. stderr: ${stderr}`));
      }, 10_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`MCP exited with ${code}. stderr: ${stderr}`));
        }
      });
      child.stdout.on("data", () => {
        const line = stdout.trim().split("\n").find(Boolean);
        if (!line) return;
        try {
          const parsed = JSON.parse(line) as Record<string, any>;
          child.kill();
          resolve(parsed);
        } catch {
          // Wait for a complete JSON-RPC line.
        }
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "code-atlas-regression", version: "1" },
        },
      })}\n`);
    });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "code-atlas");
    assert.ok(stdout.trim().split("\n").every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Codex refuses an ephemeral CLI path before writing persistent integration", async () => {
  const repoPath = await fixture("codex-ephemeral");
  try {
    const modulePath = path.join(repoPath, "dist", "infrastructure", "integration", "codex.adapter.js");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await writeFile(path.join(repoPath, "dist", "cli.js"), "#!/usr/bin/env node\n");
    await assert.rejects(
      () => resolveCodeAtlasMcpLaunch(pathToFileURL(modulePath).href),
      /ephemeral installation.*install CodeAtlas durably/,
    );
    assert.equal(isEphemeralCodeAtlasPath(path.join(repoPath, "dist", "cli.js")), true);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Codex reports an absolute launcher with missing files as stale", async () => {
  const repoPath = await fixture("codex-stale");
  try {
    const home = path.join(repoPath, "home");
    const bin = path.join(repoPath, "bin");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = path.join(home, ".codex", "config.toml");
    await writeFile(configPath, `[mcp_servers.code-atlas]\ncommand = "${path.join(repoPath, "missing-node")}"\nargs = [ "${path.join(repoPath, "missing-cli.js")}", "mcp" ]\nenabled = true\n`);
    const status = await createAgentIntegrationService({
      cwd: repoPath,
      home,
      env: { PATH: bin },
      platform: "linux",
    }).status("codex", { repoPath });
    assert.equal(status.state, "stale");
    assert.equal(status.codeAtlasMcpConfigured, false);
    assert.equal(status.configurationValid, false);
    assert.match(status.warnings[0], /stale.*connect codex/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("MCP has a TTY-only human notice and preserves piped protocol mode", () => {
  assert.equal(isInteractiveMcpSession({ isTTY: true }, { isTTY: true }), true);
  assert.equal(isInteractiveMcpSession({ isTTY: false }, { isTTY: false }), false);
  assert.match(MCP_INTERACTIVE_NOTICE, /intended to be launched by an MCP client/);
  assert.match(MCP_INTERACTIVE_NOTICE, /Press Ctrl\+C to stop/);
});

test("serve is exposed by the compiled CLI", async () => {
  const repoPath = await fixture("serve-help");
  try {
    const help = await runCli(repoPath, "--help");
    assert.match(help.stdout, /serve \[path\]/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

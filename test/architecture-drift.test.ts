import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { architectureDrift } from "../src/core/architecture/architecture-drift.service.js";
import { loadArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";

const execFile = promisify(execFileCallback);

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function writeFiles(repoPath: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function withGitRepo(
  files: Record<string, string>,
  callback: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-architecture-drift-"));
  try {
    await writeFiles(repoPath, files);
    await git(repoPath, ["init", "-q"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "initial"]);
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

const policy = JSON.stringify({
  version: 1,
  architecture: {
    groups: [
      { id: "ui", include: ["src/ui/**"] },
      { id: "domain", include: ["src/domain/**"] },
      { id: "data", include: ["src/data/**"] },
    ],
    defaultCrossGroupAction: "allow",
    rules: [{ id: "ui-no-data", from: "ui", to: "data", action: "deny", edgeKinds: ["imports"], severity: "high", message: "UI must use domain APIs." }],
  },
}, null, 2);

test("architectureDrift reports an introduced forbidden import with graph evidence", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": policy,
    "src/ui/screen.ts": "export function render() { return true; }\n",
    "src/domain/service.ts": "export function service() { return true; }\n",
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), 'import { repository } from "../data/repository.js";\nexport function render() { return repository(); }\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.policy.configured, true);
    assert.equal(result.introduced.some((finding) => finding.kind === "forbidden_dependency" && finding.ruleId === "ui-no-data"), true);
    assert.equal(result.introduced[0]?.status, "introduced");
    assert.equal(result.introduced[0]?.edgeKind, "imports");
    assert.equal(result.introduced[0]?.confidence, "high");
    assert.equal(result.introduced[0]?.cause, "code_change");
  });
});

test("architectureDrift attributes a policy-only violation to the target policy", async () => {
  const allowPolicy = JSON.stringify({ version: 1, architecture: { groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }], defaultCrossGroupAction: "allow" } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": allowPolicy,
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n',
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), policy);
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.length, 1);
    assert.equal(result.introduced[0]?.cause, "policy_change");
    assert.equal(result.policy.baseline.configured, true);
    assert.equal(result.policy.target.configured, true);
    assert.equal(result.policy.changeKind, "modified");
    assert.equal(result.policy.fileChanged, true);
    assert.equal(result.policy.semanticChanged, true);
  });
});

test("architectureDrift attributes a code-and-policy interaction to both", async () => {
  const allowPolicy = JSON.stringify({ version: 1, architecture: { groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }], defaultCrossGroupAction: "allow" } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": allowPolicy,
    "src/ui/screen.ts": "export const screen = true;\n",
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), policy);
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced[0]?.cause, "both");
  });
});

test("architectureDrift excludes pre-existing debt and reports a resolved violation", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": policy,
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport function render() { return repository(); }\n',
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    const unchanged = await architectureDrift(repoPath);
    assert.equal(unchanged.introduced.length, 0);
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), "export function render() { return false; }\n");
    const resolved = await architectureDrift(repoPath);
    assert.equal(resolved.introduced.length, 0);
    assert.equal(resolved.resolved.some((finding) => finding.kind === "forbidden_dependency" && finding.ruleId === "ui-no-data"), true);
    assert.equal(resolved.resolved.find((finding) => finding.kind === "forbidden_dependency")?.cause, "code_change");
  });
});

test("architectureDrift does not churn for rule metadata or formatting changes", async () => {
  const baselinePolicy = JSON.stringify({ version: 1, architecture: { groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }], rules: [{ id: "old-id", from: "ui", to: "data", action: "deny", edgeKinds: ["imports"], severity: "medium", message: "Old message" }] } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": baselinePolicy,
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n',
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    const targetPolicy = { architecture: { rules: [{ message: "New message", severity: "high", edgeKinds: ["imports"], action: "deny", to: "data", from: "ui", id: "new-id" }], groups: [{ exclude: [], include: ["src/data/**"], id: "data" }, { exclude: [], include: ["src/ui/**"], id: "ui" }] }, version: 1 };
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify(targetPolicy, null, 2));
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.length, 0);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.policy.semanticChanged, false);
  });
});

test("architectureDrift uses the staged policy and ignores unstaged policy edits", async () => {
  const allowPolicy = JSON.stringify({ version: 1, architecture: { groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }] } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": allowPolicy,
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n',
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), policy);
    await git(repoPath, ["add", "codeatlas.config.json"]);
    await writeFile(path.join(repoPath, "codeatlas.config.json"), allowPolicy);
    const result = await architectureDrift(repoPath, { mode: "staged" });
    assert.equal(result.introduced.length, 1);
    assert.equal(result.introduced[0]?.cause, "policy_change");
  });
});

test("architectureDrift uses historical policies instead of the checkout policy", async () => {
  const allowPolicy = JSON.stringify({ version: 1, architecture: { groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }] } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": allowPolicy,
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n',
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    const first = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "codeatlas.config.json"), policy);
    await git(repoPath, ["add", "codeatlas.config.json"]);
    await git(repoPath, ["commit", "-qm", "deny-policy"]);
    const second = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "codeatlas.config.json"), allowPolicy);
    const result = await architectureDrift(repoPath, { mode: "range", base: first, head: second });
    assert.equal(result.introduced.length, 1);
    assert.equal(result.introduced[0]?.cause, "policy_change");
  });
});

test("architectureDrift consumes an untracked working-tree policy", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/ui/screen.ts": 'import { repository } from "../data/repository.js";\nexport const screen = repository;\n',
    "src/data/repository.ts": "export const repository = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), policy);
    const result = await architectureDrift(repoPath);
    assert.equal(result.policy.baseline.configured, false);
    assert.equal(result.policy.target.configured, true);
    assert.equal(result.policy.changeKind, "added");
    assert.equal(result.introduced[0]?.cause, "policy_change");
  });
});

test("architectureDrift applies strict allowlists and edge-kind-specific rules", async () => {
  const strictPolicy = JSON.stringify({
    version: 1,
    architecture: {
      groups: [
        { id: "ui", include: ["src/ui/**"] },
        { id: "domain", include: ["src/domain/**"] },
        { id: "data", include: ["src/data/**"] },
      ],
      defaultCrossGroupAction: "deny",
      rules: [
        { id: "ui-domain", from: "ui", to: "domain", action: "allow" },
        { id: "domain-data", from: "domain", to: "data", action: "allow" },
      ],
    },
  });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": strictPolicy,
    "src/ui/screen.ts": "export function render() { return true; }\n",
    "src/domain/service.ts": "export function service() { return true; }\n",
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), [
      'import { service } from "../domain/service.js";',
      'import { repository } from "../data/repository.js";',
      "export function render() { return service() && repository(); }",
    ].join("\n"));
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.filter((finding) => finding.kind === "forbidden_dependency").length >= 1, true);
    assert.equal(result.introduced.some((finding) => finding.toGroup === "data"), true);
  });
});

test("architectureDrift detects a new import cycle without policy configuration", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": 'import { b } from "./b.js";\nexport function a() { return b(); }\n',
    "src/b.ts": "export function b() { return true; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/b.ts"), 'import { a } from "./a.js";\nexport function b() { return a(); }\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.policy.configured, false);
    assert.equal(result.policy.cyclesEnabled, true);
    assert.equal(result.introduced.some((finding) => finding.kind === "dependency_cycle"), true);
    assert.equal(result.introduced.find((finding) => finding.kind === "dependency_cycle")?.evidence.some((item) => item.kind === "cycle_path"), true);
  });
});

test("architectureDrift uses full target context to detect a cycle closed by one added edge", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function a() { return true; }\n",
    "src/b.ts": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
    "src/c.ts": 'import { a } from "./a.js";\nexport function c() { return a(); }\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), 'import { b } from "./b.js";\nexport function a() { return b(); }\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.filter((finding) => finding.kind === "dependency_cycle").length, 1);
  });
});

test("architecture policy preserves ambiguous membership and rejects invalid rules", async () => {
  await withGitRepo({ "codeatlas.config.json": policy }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({ version: 1, architecture: { groups: [{ id: "a", include: ["src/**"] }, { id: "b", include: ["src/**"] }] } }));
    const loaded = await loadArchitecturePolicy(repoPath);
    assert.equal(loaded.groups.length, 2);
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({ version: 1, architecture: { groups: [{ id: "a", include: ["src/**"] }], rules: [{ id: "bad", from: "a", to: "missing", action: "deny" }] } }));
    await assert.rejects(() => loadArchitecturePolicy(repoPath), /unknown group/i);
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({ version: 1, architecture: { groups: [{ id: "a", include: ["src/a/**"] }, { id: "b", include: ["src/b/**"] }], rules: [{ id: "allow", from: "a", to: "b", action: "allow" }, { id: "deny", from: "a", to: "b", action: "deny" }] } }));
    await assert.rejects(() => loadArchitecturePolicy(repoPath), /conflict|contradict/i);
  });
});

test("architectureDrift reports ambiguous membership without making a policy guess", async () => {
  const ambiguousPolicy = JSON.stringify({
    version: 1,
    architecture: {
      groups: [
        { id: "one", include: ["src/**"] },
        { id: "two", include: ["src/**"] },
      ],
      requireClassification: true,
    },
  });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": ambiguousPolicy,
    "src/a.ts": "export const a = true;\n",
    "src/b.ts": "export const b = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.length, 0);
    assert.equal(result.diagnostics.gaps.some((gap) => gap.kind === "ambiguous_architecture_membership"), true);
    assert.equal(result.authoritativeNegativeResults, false);
  });
});

test("architectureDrift reports a resolved import cycle", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export const a = true;\n");
    const result = await architectureDrift(repoPath);
    assert.equal(result.resolved.some((finding) => finding.kind === "dependency_cycle"), true);
  });
});

test("architectureDrift attributes cycle enablement changes locally", async () => {
  const disabled = JSON.stringify({ version: 1, architecture: { cycles: { enabled: false } } });
  const enabled = JSON.stringify({ version: 1, architecture: { cycles: { enabled: true } } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": disabled,
    "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), enabled);
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.find((finding) => finding.kind === "dependency_cycle")?.cause, "policy_change");
  });
});

test("architectureDrift attributes a new cycle plus enablement to both", async () => {
  const disabled = JSON.stringify({ version: 1, architecture: { cycles: { enabled: false } } });
  const enabled = JSON.stringify({ version: 1, architecture: { cycles: { enabled: true } } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": disabled,
    "src/a.ts": "export const a = true;\n",
    "src/b.ts": "export const b = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), enabled);
    await writeFile(path.join(repoPath, "src/a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    await writeFile(path.join(repoPath, "src/b.ts"), 'import { a } from "./a.js";\nexport const b = a;\n');
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.find((finding) => finding.kind === "dependency_cycle")?.cause, "both");
  });
});

test("architectureDrift does not report a severity-only cycle policy change", async () => {
  const medium = JSON.stringify({ version: 1, architecture: { cycles: { enabled: true, severity: "medium" } } });
  const high = JSON.stringify({ version: 1, architecture: { cycles: { enabled: true, severity: "high" } } });
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": medium,
    "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), high);
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.length, 0);
    assert.equal(result.resolved.length, 0);
  });
});

test("architectureDrift treats explicit default policy as equivalent to no config", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export const a = true;\n",
    "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({ version: 1, architecture: { defaultCrossGroupAction: "allow", cycles: { enabled: true, severity: "medium" } } }));
    const result = await architectureDrift(repoPath);
    assert.equal(result.introduced.length, 0);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.policy.semanticChanged, false);
  });
});

test("architectureDrift rejects an external config path", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export const a = true;\n",
  }, async (repoPath) => {
    await assert.rejects(() => architectureDrift(repoPath, { configPath: "../outside.json" }), /repository-relative|inside the repository/i);
  });
});

test("architectureDrift is read-only and preserves the policy file", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "codeatlas.config.json": policy,
    "src/ui/screen.ts": "export function render() { return true; }\n",
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    const before = await readFile(path.join(repoPath, "codeatlas.config.json"), "utf8");
    const statusBefore = await git(repoPath, ["status", "--porcelain=v1"]);
    await architectureDrift(repoPath);
    assert.equal(await readFile(path.join(repoPath, "codeatlas.config.json"), "utf8"), before);
    assert.equal(await git(repoPath, ["status", "--porcelain=v1"]), statusBefore);
  });
});

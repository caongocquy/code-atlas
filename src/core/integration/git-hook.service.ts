import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { HookName, HookOptions, HookStatus } from "./integration.types.js";
import { readConfigFile, writeConfigFile } from "../../infrastructure/integration/config-file.js";
import { hasManagedBlock, removeManagedBlock, updateManagedBlock } from "../../infrastructure/integration/managed-block.js";

const execFile = promisify(execFileCallback);
const START = "# code-atlas:start";
const END = "# code-atlas:end";
const hooksToInstall: HookName[] = ["post-commit", "post-checkout"];

export class GitHookService {
  constructor(private readonly repoPath: string) {}

  async status(): Promise<HookStatus> {
    const hooksPath = await this.resolveHooksPath();
    const helperPath = path.join(this.repoPath, ".codeatlas", "hooks", "code-atlas-sync.sh");
    if (!hooksPath) {
      return {
        repoPath: this.repoPath,
        helperPath,
        hooks: hookValues(this.repoPath, undefined),
        warnings: ["Repository is not a Git worktree."],
      };
    }

    const hooks = {} as HookStatus["hooks"];
    for (const hook of hooksToInstall) {
      const hookPath = path.join(hooksPath, hook);
      const file = await readConfigFile(hookPath);
      hooks[hook] = { path: hookPath, installed: hasManagedBlock(file.text, START, END) };
    }
    return { repoPath: this.repoPath, hooksPath, helperPath, hooks, warnings: [] };
  }

  async install(options: Pick<HookOptions, "hooks"> = {}): Promise<HookStatus> {
    const hooksPath = await this.requireHooksPath();
    await ensureGeneratedStateIgnore(this.repoPath);
    const selected = options.hooks?.length ? options.hooks : hooksToInstall;
    const helperPath = path.join(this.repoPath, ".codeatlas", "hooks", "code-atlas-sync.sh");
    const helper = await readConfigFile(helperPath);
    const helperText = "#!/bin/sh\n\nREPO_ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || exit 0)\"\ncd \"$REPO_ROOT\" || exit 0\nif command -v code-atlas >/dev/null 2>&1; then\n  code-atlas sync --quiet >/dev/null 2>&1 || true\nfi\n\nexit 0\n";
    if (helper.text !== helperText) await writeConfigFile({ ...helper, mode: 0o700 }, helperText);

    for (const hook of selected) {
      const hookPath = path.join(hooksPath, hook);
      const file = await readConfigFile(hookPath);
      const updated = updateManagedBlock(file.text, START, END, [
        "# CodeAtlas optional refresh; failures never block Git.",
        "CODE_ATLAS_ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || exit 0)\"",
        "\"$CODE_ATLAS_ROOT/.codeatlas/hooks/code-atlas-sync.sh\" || true",
        "unset CODE_ATLAS_ROOT",
      ].join("\n"), "# code-atlas:final-newline={value}");
      if (updated !== file.text) await writeConfigFile({ ...file, mode: file.mode ?? 0o755 }, updated);
    }
    return this.status();
  }

  async uninstall(options: Pick<HookOptions, "hooks"> = {}): Promise<HookStatus> {
    const hooksPath = await this.resolveHooksPath();
    const selected = options.hooks?.length ? options.hooks : hooksToInstall;
    if (hooksPath) {
      for (const hook of selected) {
        const hookPath = path.join(hooksPath, hook);
        const file = await readConfigFile(hookPath);
        const updated = removeManagedBlock(file.text, START, END);
        if (updated !== file.text) await writeConfigFile(file, updated);
      }
    }

    const status = await this.status();
    if (!Object.values(status.hooks).some((hook) => hook.installed)) {
      await fs.rm(status.helperPath, { force: true });
    }
    return this.status();
  }

  private async requireHooksPath(): Promise<string> {
    const hooksPath = await this.resolveHooksPath();
    if (!hooksPath) throw new Error(`Not a Git worktree: ${this.repoPath}`);
    await fs.mkdir(hooksPath, { recursive: true });
    return hooksPath;
  }

  private async resolveHooksPath(): Promise<string | undefined> {
    try {
      const result = await execFile("git", ["rev-parse", "--git-path", "hooks"], { cwd: this.repoPath });
      const value = result.stdout.trim();
      if (!value) return undefined;
      return path.resolve(this.repoPath, value);
    } catch {
      return undefined;
    }
  }
}

async function ensureGeneratedStateIgnore(repoPath: string): Promise<void> {
  const file = await readConfigFile(path.join(repoPath, ".codeatlas", ".gitignore"));
  const rules = file.text.split(/\r?\n/).filter(Boolean);
  const missing = ["*", "!.gitignore"].filter((rule) => !rules.includes(rule));
  if (missing.length === 0) return;
  const prefix = file.text.length === 0 ? "" : file.text.endsWith("\n") ? file.text : `${file.text}\n`;
  await writeConfigFile(file, `${prefix}${missing.join("\n")}\n`);
}

function hookValues(repoPath: string, hooksPath: string | undefined): HookStatus["hooks"] {
  return Object.fromEntries(hooksToInstall.map((hook) => [hook, {
    path: hooksPath ? path.join(hooksPath, hook) : path.join(repoPath, ".git", "hooks", hook),
    installed: false,
  }])) as HookStatus["hooks"];
}

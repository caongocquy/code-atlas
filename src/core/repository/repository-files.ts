import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { LANGUAGE_CONFIGS } from "../graph/parsers/languages.js";
import { canonicalRepositoryPath } from "./repository-identity.js";

export { getRepoId } from "./repository-identity.js";

const allowedExtensions = new Set(LANGUAGE_CONFIGS.flatMap((config) => config.extensions));

const ignoredDirectories = new Set([
  ".git",
  ".codeatlas",
  ".code-rag",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".dart_tool",
  "Pods",
  "DerivedData",
  ".gradle",
  ".venv",
  "venv",
  "vendor",
  ".opencode",
  ".codex",
  ".claude",
  ".omo",
  ".specify",
  ".agents",
  ".local",
  ".playwright-mcp",
  ".jarvis-chat-session",
]);

async function scanDirectory(
  directory: string,
  rootPath: string,
  matcher: Ignore,
): Promise<string[]> {
  if (directory !== rootPath && await hasRepositoryMarker(directory)) {
    return [];
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = path.relative(rootPath, fullPath).split(path.sep).join("/");

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name) || matcher.ignores(`${relativePath}/`)) {
        continue;
      }

      files.push(...(await scanDirectory(fullPath, rootPath, matcher)));

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!allowedExtensions.has(path.extname(entry.name)) || matcher.ignores(relativePath)) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export async function scanRepo(repoPath: string): Promise<string[]> {
  const rootPath = path.resolve(repoPath);
  const matcher = await createIgnoreMatcher(rootPath);
  return (await scanDirectory(rootPath, rootPath, matcher)).sort();
}

async function createIgnoreMatcher(rootPath: string): Promise<Ignore> {
  const matcher = (ignore as unknown as () => Ignore)();
  const patterns = [...await readIgnorePatterns(rootPath), ...[...ignoredDirectories].map((name) => `${name}/`), ".git/"];
  for (const pattern of patterns) {
    try {
      matcher.add(pattern);
    } catch {
      // Ignore malformed patterns and keep scanning with the remaining rules.
    }
  }
  return matcher;
}

async function readIgnorePatterns(rootPath: string): Promise<string[]> {
  try {
    const contents = await fs.readFile(path.join(rootPath, ".gitignore"), "utf8");
    const patterns = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // AtlasStore can protect a custom database path with this generated root rule.
    if (patterns.length === 2 && patterns[0] === "*" && patterns[1] === "!.gitignore") return [];
    return patterns;
  } catch {
    return [];
  }
}

async function hasRepositoryMarker(directory: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function repositoryRelativePath(
  repoPath: string,
  filePath: string,
): string {
  const rootPath = canonicalRepositoryPath(repoPath);
  const absolutePath = canonicalRepositoryPath(filePath);
  const relativePath = path.relative(rootPath, absolutePath);

  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`File is outside repository root: ${filePath}`);
  }

  return relativePath.split(path.sep).join("/");
}

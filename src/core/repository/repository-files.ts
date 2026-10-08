import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { LANGUAGE_CONFIGS } from "../graph/parsers/languages.js";
import { readConfigBytes } from "../indexing/framework-config-acquisition.js";
import { readRepositoryConfig } from "../../infrastructure/semantic/semantic-config.store.js";
import { canonicalRepositoryPath } from "./repository-identity.js";

export { getRepoId } from "./repository-identity.js";

const BASELINE_ALLOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".dart",
  ".py",
  ".md",
] as const;

const allowedExtensions = new Set([
  ...BASELINE_ALLOWED_EXTENSIONS,
  ...LANGUAGE_CONFIGS.flatMap((config) => config.extensions),
]);

const safeExcludedDirectories = new Set([
  ".git",
  ".codeatlas",
  ".code-rag",
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

const STACK_EXCLUDES: Record<string, readonly string[]> = {
  node: ["node_modules/", "dist/", "build/", "coverage/", ".turbo/"],
  next: [".next/", "out/"],
  java: ["target/", "build/", ".gradle/"],
  dart: [".dart_tool/", "build/"],
  python: ["build/", "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".venv/", "venv/"],
  rust: ["target/"],
  go: ["vendor/"],
  ios: ["Pods/", "DerivedData/", ".build/"],
};

export type RepositoryExcludeResolution = {
  stacks: string[];
  patterns: string[];
  gitignorePatterns: string[];
  summary: string;
  matches(relativePath: string, isDirectory?: boolean): boolean;
};

export async function resolveRepositoryExcludes(repoPath: string): Promise<RepositoryExcludeResolution> {
  const rootPath = path.resolve(repoPath);
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const sourceLanguages = new Set(entries
    .filter((entry) => entry.isFile())
    .map((entry) => LANGUAGE_CONFIGS.find((config) => config.extensions.includes(path.extname(entry.name).toLowerCase()))?.language)
    .filter((language): language is NonNullable<typeof language> => language !== undefined));
  for (const name of ["src", "app", "lib", "pages", "test", "tests"]) {
    const entry = entries.find((candidate) => candidate.name === name && candidate.isDirectory());
    if (entry) for (const language of await readSourceLanguages(path.join(rootPath, name), 2)) sourceLanguages.add(language);
  }
  const stacks = new Set<string>();
  const packageJson = await readRootJson(rootPath, "package.json");
  if (packageJson || names.has("node_modules") || sourceLanguages.has("typescript") || sourceLanguages.has("tsx") || sourceLanguages.has("javascript")) stacks.add("node");
  if ([...names].some((name) => /^next\.config\.(c?js|mjs|ts)$/.test(name)) || hasDependency(packageJson, "next")) stacks.add("next");
  if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts") || sourceLanguages.has("java") || sourceLanguages.has("kotlin")) stacks.add("java");
  if (names.has("pubspec.yaml") || sourceLanguages.has("dart")) stacks.add("dart");
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py") || sourceLanguages.has("python")) stacks.add("python");
  if (names.has("Cargo.toml") || sourceLanguages.has("rust")) stacks.add("rust");
  if (names.has("go.mod") || sourceLanguages.has("go")) stacks.add("go");
  if (names.has("Podfile") || names.has("Package.swift") || [...names].some((name) => name.endsWith(".xcodeproj")) || sourceLanguages.has("swift")) stacks.add("ios");

  const projectPatterns = (await readRepositoryConfig(rootPath)).excludes ?? [];
  const gitignorePatterns = await readIgnorePatterns(rootPath);
  const patterns = [
    ...[...safeExcludedDirectories].map((name) => `${name}/`),
    ...[...stacks].flatMap((stack) => STACK_EXCLUDES[stack] ?? []),
    ...projectPatterns,
    ...gitignorePatterns,
  ];
  const matcher = (ignore as unknown as () => Ignore)();
  for (const pattern of patterns) {
    try {
      matcher.add(pattern);
    } catch {
      // Ignore malformed patterns and keep scanning with the remaining rules.
    }
  }
  const sources = [
    `built-ins ${safeExcludedDirectories.size}`,
    ...[...stacks].sort().map((stack) => `${stack} ${STACK_EXCLUDES[stack]?.length ?? 0}`),
    ...(projectPatterns.length > 0 ? [`project config ${projectPatterns.length}`] : []),
    ...(gitignorePatterns.length > 0 ? [`.gitignore ${gitignorePatterns.length}`] : []),
  ];
  return {
    stacks: [...stacks].sort(),
    patterns,
    gitignorePatterns,
    summary: sources.join(" · "),
    matches(relativePath, isDirectory = false) {
      const normalized = relativePath.split(path.sep).join("/");
      if (normalized.split("/").some((part) => safeExcludedDirectories.has(part))) return true;
      return matcher.ignores(isDirectory && !normalized.endsWith("/") ? `${normalized}/` : normalized);
    },
  };
}

async function readRootJson(rootPath: string, name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const bytes = await readConfigBytes(path.join(rootPath, name));
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function readSourceLanguages(
  directory: string,
  maxDepth: number,
): Promise<Set<(typeof LANGUAGE_CONFIGS)[number]["language"]>> {
  const languages = new Set<(typeof LANGUAGE_CONFIGS)[number]["language"]>();
  const excluded = new Set([".git", "node_modules", "dist", "build", "target", "vendor", ".codeatlas"]);
  const pending = [{ directory, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 500) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited >= 500) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && current.depth < maxDepth && !excluded.has(entry.name)) {
        pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const language = LANGUAGE_CONFIGS.find((config) => config.extensions.includes(path.extname(entry.name).toLowerCase()))?.language;
        if (language) languages.add(language);
      }
    }
  }
  return languages;
}

function hasDependency(packageJson: Record<string, unknown> | undefined, name: string): boolean {
  const dependencies = packageJson?.dependencies;
  const devDependencies = packageJson?.devDependencies;
  return [dependencies, devDependencies].some((value) =>
    value && typeof value === "object" && name in value,
  );
}

async function scanDirectory(
  directory: string,
  rootPath: string,
  excludes: RepositoryExcludeResolution,
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
      if (excludes.matches(relativePath, true)) {
        continue;
      }

      files.push(...(await scanDirectory(fullPath, rootPath, excludes)));

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!allowedExtensions.has(path.extname(entry.name)) || excludes.matches(relativePath)) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export async function scanRepo(
  repoPath: string,
  resolvedExcludes?: RepositoryExcludeResolution,
): Promise<string[]> {
  const rootPath = path.resolve(repoPath);
  const excludes = resolvedExcludes ?? await resolveRepositoryExcludes(rootPath);
  return (await scanDirectory(rootPath, rootPath, excludes)).sort();
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

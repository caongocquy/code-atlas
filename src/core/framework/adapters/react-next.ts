import path from "node:path";

import { frameworkEntityKey } from "../framework-identity.js";
import { isRelativeImport, resolveImportCandidates } from "../../graph/imports.js";
import type { SyntaxObservation } from "../../facts/objective-syntax.types.js";
import type {
  DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence,
  FrameworkConfigFact, FrameworkEvidenceRef, FrameworkSemanticAdapter, FrameworkSubjectRef,
} from "../framework.types.js";

const refsFor = (relativePath: string, inputKey: string): FrameworkEvidenceRef[] => [{ relativePath, inputKey }];

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function configForFile(config: readonly FrameworkConfigFact[], file: string, kinds: readonly FrameworkConfigFact["kind"][]): FrameworkConfigFact | undefined {
  return config.filter((item) => kinds.includes(item.kind) && (path.posix.dirname(item.relativePath) === "." || file.startsWith(`${path.posix.dirname(item.relativePath)}/`)))
    .sort((left, right) => path.posix.dirname(right.relativePath).length - path.posix.dirname(left.relativePath).length || left.relativePath.localeCompare(right.relativePath))[0];
}

function configPatternMatches(config: FrameworkConfigFact, file: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized)) return false;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(config.relativePath), normalized));
  if (!/[?*]/.test(target)) return file === target || file.startsWith(`${target}/`);
  return path.posix.matchesGlob(file, target);
}

function configIncludesFile(config: FrameworkConfigFact, file: string): boolean {
  const files = Array.isArray(config.values.files) ? config.values.files : undefined;
  const include = Array.isArray(config.values.include) ? config.values.include : undefined;
  const exclude = Array.isArray(config.values.exclude) ? config.values.exclude : undefined;
  if (files?.some((item) => typeof item === "string" && configPatternMatches(config, file, item))) return true;
  const included = include
    ? include.some((item) => typeof item === "string" && configPatternMatches(config, file, item))
    : files === undefined && !Array.isArray(config.values.references);
  return included && !exclude?.some((item) => typeof item === "string" && configPatternMatches(config, file, item));
}

function configsForFile(config: readonly FrameworkConfigFact[], file: string): { applicable: FrameworkConfigFact[]; consulted: FrameworkConfigFact[] } {
  const scoped = config.filter((item) => (item.kind === "tsconfig" || item.kind === "jsconfig")
    && (path.posix.dirname(item.relativePath) === "." || file.startsWith(`${path.posix.dirname(item.relativePath)}/`)));
  if (scoped.length === 0) return { applicable: [], consulted: [] };
  const closest = Math.max(...scoped.map((item) => path.posix.dirname(item.relativePath).length));
  const sameScope = scoped.filter((item) => path.posix.dirname(item.relativePath).length === closest);
  const roots = sameScope.filter((item) => /^(?:tsconfig|jsconfig)\.json$/i.test(path.posix.basename(item.relativePath)));
  const byPath = new Map(scoped.map((item) => [item.relativePath, item]));
  const consulted = new Map<string, FrameworkConfigFact>();
  const visit = (item: FrameworkConfigFact): void => {
    if (consulted.has(item.relativePath)) return;
    consulted.set(item.relativePath, item);
    if (!Array.isArray(item.values.references)) return;
    for (const reference of item.values.references) {
      const referencePath = record(reference)?.path;
      if (typeof referencePath !== "string") continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(item.relativePath), referencePath.replaceAll("\\", "/")));
      const next = byPath.get(target) ?? byPath.get(`${target}.json`) ?? byPath.get(path.posix.join(target, "tsconfig.json"));
      if (next) visit(next);
    }
  };
  const seeds = roots.some((item) => Array.isArray(item.values.references)) ? roots : sameScope;
  for (const item of seeds.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) visit(item);
  const ordered = [...consulted.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { applicable: ordered.filter((item) => configIncludesFile(item, file)), consulted: ordered };
}

function matchedAliasPaths(config: FrameworkConfigFact | undefined, specifier: string): { matched: boolean; paths: string[] } {
  const options = record(config?.values.compilerOptions);
  const aliases = record(options?.paths);
  if (!config || !aliases) return { matched: false, paths: [] };
  const base = path.posix.join(path.posix.dirname(config.relativePath), typeof options?.baseUrl === "string" ? options.baseUrl : ".");
  const patterns = Object.keys(aliases).filter((pattern) => {
    const star = pattern.indexOf("*");
    if (star !== pattern.lastIndexOf("*")) return false;
    const prefix = star < 0 ? pattern : pattern.slice(0, star);
    const suffix = star < 0 ? "" : pattern.slice(star + 1);
    return star < 0 ? specifier === pattern : specifier.startsWith(prefix) && specifier.endsWith(suffix);
  }).sort((left, right) => Number(left.includes("*")) - Number(right.includes("*"))
    || right.split("*")[0]!.length - left.split("*")[0]!.length
    || right.split("*").at(-1)!.length - left.split("*").at(-1)!.length
    || left.localeCompare(right));
  const pattern = patterns[0];
  if (!pattern) return { matched: false, paths: [] };
  const star = pattern.indexOf("*");
  const capture = star < 0 ? "" : specifier.slice(star, specifier.length - (pattern.length - star - 1));
  const targets = aliases[pattern];
  if (!Array.isArray(targets)) return { matched: false, paths: [] };
  const matches = targets.flatMap((target) => typeof target === "string" && (target.match(/\*/g)?.length ?? 0) <= (star < 0 ? 0 : 1)
    ? resolveImportCandidates(path.posix.join(base, "__config__.ts"), star < 0 ? target : target.replace("*", capture)) : []);
  return { matched: matches.length > 0, paths: [...new Set(matches)].sort() };
}

function importTarget(ctx: FrameworkAnalysisContext, file: string, specifier: string): { kind: "project" | "external" | "unknown"; paths: readonly string[]; configKeys: readonly string[] } {
  if (isRelativeImport(specifier)) return { kind: "project", paths: resolveImportCandidates(file, specifier), configKeys: [] };
  const { applicable, consulted } = configsForFile(ctx.config, file);
  const configKeys = consulted.map((item) => item.inputKey);
  const aliases = applicable.map((item) => matchedAliasPaths(item, specifier)).filter((item) => item.matched);
  if (aliases.length > 0) {
    const variants = new Set(aliases.map((item) => JSON.stringify(item.paths)));
    return variants.size === 1
      ? { kind: "project", paths: aliases[0]!.paths, configKeys }
      : { kind: "unknown", paths: [], configKeys };
  }

  const baseUrls = applicable.flatMap((item) => {
    const compiler = record(item.values.compilerOptions);
    if (typeof compiler?.baseUrl !== "string") return [];
    const base = path.posix.join(path.posix.dirname(item.relativePath), compiler.baseUrl);
    return [resolveImportCandidates(path.posix.join(base, "__config__.ts"), specifier)];
  });
  if (baseUrls.length > 0 && baseUrls.some((candidates) => candidates.some((candidate) => ctx.graph.nodes.some((node) => node.type === "file" && node.file === candidate)))) {
    const variants = new Set(baseUrls.map((item) => JSON.stringify(item)));
    return variants.size === 1
      ? { kind: "project", paths: baseUrls[0]!, configKeys }
      : { kind: "unknown", paths: [], configKeys };
  }

  const workspace = ctx.config.filter((item) => item.kind === "package" && typeof item.values.name === "string"
    && (item.values.name === specifier || specifier.startsWith(`${item.values.name}/`)))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))[0];
  if (workspace) {
    configKeys.push(workspace.inputKey);
    const subpath = specifier.slice((workspace.values.name as string).length).replace(/^\//, "");
    const entry = subpath || [workspace.values.module, workspace.values.main, workspace.values.types].find((item): item is string => typeof item === "string") || "index";
    const base = path.posix.join(path.posix.dirname(workspace.relativePath), "__package__.ts");
    return { kind: "project", paths: resolveImportCandidates(base, entry), configKeys };
  }

  const manifest = configForFile(ctx.config, file, ["package"]);
  if (manifest) configKeys.push(manifest.inputKey);
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .some((section) => Object.hasOwn(record(manifest?.values[section]) ?? {}, packageName ?? ""));
  return { kind: declared ? "external" : "unknown", paths: [], configKeys };
}

function canonicalGraphPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

type ImportedComponentTargets = {
  nodes: FrameworkAnalysisContext["graph"]["nodes"][number][];
  paths: Set<string>;
  configKeys: Set<string>;
};

const emptyImportedTargets = (): ImportedComponentTargets => ({ nodes: [], paths: new Set(), configKeys: new Set() });

function verifiedLazyNamedExport(
  ctx: FrameworkAnalysisContext,
  file: string,
  localName: string,
  visited: Set<string>,
  consulted: Set<string>,
): ImportedComponentTargets {
  const result = emptyImportedTargets();
  const fileFacts = (ctx.lookupFacts ?? ctx.facts).find((item) => canonicalGraphPath(item.relativePath) === file)?.facts;
  if (!fileFacts || fileFacts.parseStatus !== "complete") return result;
  const rootScope = fileFacts.containmentScopes.find((item) => item.kind === "program")?.localId;
  const bindings = fileFacts.bindingSeeds.filter((item) => item.name === localName && item.bindingKind === "local" && item.ownerId === rootScope);
  if (!rootScope || bindings.length !== 1) return result;
  const assignments = fileFacts.assignments.filter((item) => item.targetId === bindings[0]!.localId && item.assignmentKind === "declaration");
  if (assignments.length !== 1) return result;
  const expression = fileFacts.expressions.find((item) => item.localId === assignments[0]!.sourceExpressionId);
  if (expression?.kind !== "call" || !expression.text) return result;

  // Strictly recognize the two-literal lazyRouteNamed(() => import("path"), "Export") form.
  // This is parser-derived initializer text, never arbitrary source-file regex matching.
  // Computed specifiers, computed export names, extra arguments and other wrappers fail closed.
  const literalCall = /^\s*lazyRouteNamed\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*(["'])([^"'\x60\\\r\n]+)\1\s*\)\s*,\s*(["'])([$A-Za-z_][$\w]*)\3\s*\)\s*$/s.exec(expression.text);
  if (!literalCall) return result;
  const [, , specifier, , exportName] = literalCall;
  if (!specifier || !exportName || !fileFacts.exports.some((item) => item.localName === localName && !item.moduleSpecifier)) return result;

  // Do not infer semantics from a function name alone: require a unique imported
  // implementation with React.lazy and the named-export-to-default adapter shape.
  const helperImports = fileFacts.imports.filter((item) => item.localName === "lazyRouteNamed" && item.importedName === "lazyRouteNamed" && item.kind === "named");
  if (helperImports.length !== 1) return result;
  const helperTarget = importTarget(ctx, file, helperImports[0]!.moduleSpecifier);
  for (const key of helperTarget.configKeys) result.configKeys.add(key);
  if (helperTarget.kind !== "project") return result;
  const helpers = helperTarget.paths.flatMap((candidate) => (ctx.lookupFacts ?? ctx.facts)
    .filter((item) => canonicalGraphPath(item.relativePath) === candidate && item.facts.parseStatus === "complete"));
  if (helpers.length !== 1) return result;
  const helper = helpers[0]!;
  const helperFacts = helper.facts;
  const declarations = helperFacts.symbols.filter((item) => item.kind === "function" && item.name === "lazyRouteNamed");
  if (declarations.length !== 1
    || !helperFacts.exports.some((item) => item.exportedName === "lazyRouteNamed" && item.localName === "lazyRouteNamed")
    || !helperFacts.imports.some((item) => item.moduleSpecifier === "react" && item.importedName === "lazy" && item.localName === "lazy")
    || !helperFacts.expressions.some((item) => item.kind === "call" && item.text && /^\s*lazy\s*\(/s.test(item.text)
      && item.range.startLine >= declarations[0]!.range.startLine && item.range.endLine <= declarations[0]!.range.endLine
      && /importWithChunkRetry\s*\(\s*importer\s*\)\s*\.then\s*\(/s.test(item.text)
      && /default\s*:\s*module\s*\[\s*exportName\s*\]/s.test(item.text))) return result;
  consulted.add(canonicalGraphPath(helper.relativePath));

  const importedTarget = importTarget(ctx, file, specifier);
  for (const key of importedTarget.configKeys) result.configKeys.add(key);
  if (importedTarget.kind !== "project") return result;
  for (const candidate of importedTarget.paths) {
    const resolved = exportedComponentTargets(ctx, candidate, exportName, visited, consulted);
    result.nodes.push(...resolved.nodes);
    for (const key of resolved.configKeys) result.configKeys.add(key);
  }
  result.nodes = [...new Map(result.nodes.map((node) => [node.id, node])).values()];
  return result;
}

function exportedComponentTargets(
  ctx: FrameworkAnalysisContext,
  filePath: string,
  exportName: string,
  visited = new Set<string>(),
  consulted = new Set<string>(),
): ImportedComponentTargets {
  const file = canonicalGraphPath(filePath);
  const result: ImportedComponentTargets = { nodes: [], paths: consulted, configKeys: new Set() };
  const visitKey = JSON.stringify([file, exportName]);
  if (visited.has(visitKey)) return result;
  visited.add(visitKey);
  consulted.add(file);

  const fileNodeIds = new Set(ctx.graph.nodes.filter((node) => node.type === "file" && canonicalGraphPath(node.file) === file).map((node) => node.id));
  const localTargets = (name: string) => ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === name && Boolean(node.qualifiedName)
    && canonicalGraphPath(node.file) === file && ctx.graph.edges.some((edge) => edge.type === "contains" && fileNodeIds.has(edge.from) && edge.to === node.id));
  const fileFacts = (ctx.lookupFacts ?? ctx.facts).find((item) => canonicalGraphPath(item.relativePath) === file);
  const matching = (fileFacts?.facts.exports ?? []).filter((item) => item.exportedName === exportName || (item.kind === "star" && item.exportedName === "*" && exportName !== "default"));
  if (matching.length === 0 && exportName !== "default") result.nodes.push(...localTargets(exportName));
  for (const item of matching) {
    if (item.moduleSpecifier) {
      for (const candidate of resolveImportCandidates(file, item.moduleSpecifier)) {
        const targetFile = canonicalGraphPath(candidate);
        if (!ctx.graph.nodes.some((node) => node.type === "file" && canonicalGraphPath(node.file) === targetFile)) continue;
        const nextName = item.kind === "star" ? exportName : item.localName;
        if (!nextName) continue;
        const resolved = exportedComponentTargets(ctx, targetFile, nextName, visited, consulted);
        result.nodes.push(...resolved.nodes);
        for (const key of resolved.configKeys) result.configKeys.add(key);
      }
    } else if (item.localName) {
      const local = localTargets(item.localName);
      result.nodes.push(...local);
      if (local.length === 0) {
        const dynamic = verifiedLazyNamedExport(ctx, file, item.localName, visited, consulted);
        result.nodes.push(...dynamic.nodes);
        for (const key of dynamic.configKeys) result.configKeys.add(key);
      }
    }
  }
  result.nodes = [...new Map(result.nodes.map((node) => [node.id, node])).values()];
  return result;
}

function importedComponentTargets(
  ctx: FrameworkAnalysisContext,
  files: readonly string[],
  exportName: string,
): ImportedComponentTargets {
  const consulted = new Set<string>();
  const configKeys = new Set<string>();
  const nodes = files.flatMap((file) => {
    const resolved = exportedComponentTargets(ctx, file, exportName, new Set(), consulted);
    for (const key of resolved.configKeys) configKeys.add(key);
    return resolved.nodes;
  });
  return { nodes: [...new Map(nodes.map((node) => [node.id, node])).values()], paths: consulted, configKeys };
}

function hasKnownDynamicLocalBinding(facts: FrameworkAnalysisContext["facts"][number]["facts"], jsx: SyntaxObservation): boolean {
  if (!jsx.name || !jsx.ownerScopeId) return false;
  const name = jsx.name.split(".").at(-1)!;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^\\w$])${escaped}(?:$|[^\\w$])`);
  const bindings = (facts.bindingSeeds ?? []).filter((item) => item.ownerId === jsx.ownerScopeId && item.bindingKind !== "import" && (item.name === name || pattern.test(item.name)));
  if (bindings.some((item) => item.bindingKind === "parameter")) return true;
  const assignments = new Map((facts.assignments ?? []).map((item) => [item.targetId, item.sourceExpressionId]));
  const expressions = new Map((facts.expressions ?? []).map((item) => [item.localId, item]));
  return bindings.some((item) => {
    const expressionId = assignments.get(item.localId);
    return expressionId !== undefined && expressions.get(expressionId)?.kind === "other";
  });
}

export function canonicalizeNextRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "next") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Next route" };
  const scope = input.scope;
  const router = input.router;
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || input.path.includes("\\") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "next" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const config = ctx.config.filter((item) => item.kind === "package");
  const configured = config.some((item) => Object.keys(item.values).some((key) => key === "next" || key === "react"));
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "react" || value.moduleSpecifier === "next" || value.moduleSpecifier.startsWith("next/")));
  if (!configured && !observed) return [];
  const refs = config.flatMap((item) => refsFor(item.relativePath, item.inputKey));
  return [
    { framework: "react", scope: "root", configured, observed, capabilities: ["react.component_usage"], refs, complete: config.every((item) => item.complete) },
    { framework: "next", scope: "root", configured: configured && config.some((item) => Object.hasOwn(item.values, "next")), observed: observed && ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "next" || value.moduleSpecifier.startsWith("next/"))), capabilities: ["next.app_routes", "next.pages_routes", "next.layout_binding", "next.execution_boundary"], refs, complete: config.every((item) => item.complete) },
  ];
}

function analyze(ctx: FrameworkAnalysisContext): { evidence: readonly FrameworkEvidence[]; dependencies: readonly { framework: "react" | "next"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[] } {
  const evidence: FrameworkEvidence[] = [];
  const dependencies = [] as { framework: "react" | "next"; scope: string; ownerPath: string; inputKeys: readonly string[]; lookupKeys: readonly string[]; complete: boolean }[];
  for (const materialized of ctx.facts) {
    const syntax = materialized.facts.frameworkSyntax;
    if (!syntax) continue;
    const localNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    const inputKey = `facts:${materialized.relativePath}`;
    const jsxNodes = syntax.nodes.filter((node) => node.kind === "jsx" && typeof node.name === "string" && node.name.length > 0);
    const lookupKeys = [...new Set(jsxNodes.map((node) => `jsx:${node.name}`))].sort();
    const dependency = { framework: "react" as const, scope: "root", ownerPath: materialized.relativePath, inputKeys: [inputKey], complete: syntax.complete };
    const configKeysByLookup = new Map(lookupKeys.map((key) => [key, new Set<string>()]));
    for (const jsx of jsxNodes) {
      if (!jsx.name || /^[a-z]/.test(jsx.name)) continue;
      const targetName = jsx.name.split(".").at(-1);
      if (!targetName) continue;
      const receiver = jsx.name.includes(".") ? jsx.name.split(".")[0] : jsx.name;
      const binding = (materialized.facts.imports ?? []).find((item) => item.localName === receiver || item.localName === targetName);
      const target = binding ? importTarget(ctx, materialized.relativePath, binding.moduleSpecifier) : undefined;
      const dynamicLocal = !binding && hasKnownDynamicLocalBinding(materialized.facts, jsx);
      for (const key of target?.configKeys ?? []) configKeysByLookup.get(`jsx:${jsx.name}`)?.add(key);
      if (target?.kind === "external") continue;
      let targetNodes: FrameworkAnalysisContext["graph"]["nodes"][number][];
      if (binding) {
        const importedName = binding.importedName === "*" ? targetName : binding.importedName ?? targetName;
        const imported = target?.kind === "project" ? importedComponentTargets(ctx, target.paths, importedName) : emptyImportedTargets();
        targetNodes = imported.nodes;
        for (const file of imported.paths) configKeysByLookup.get(`jsx:${jsx.name}`)?.add(`facts:${file}`);
        for (const key of imported.configKeys) configKeysByLookup.get(`jsx:${jsx.name}`)?.add(key);
      } else targetNodes = localNodes.filter((node) => node.type !== "file" && node.name === targetName);
      const targets = targetNodes.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      const ownerFacts = (materialized.facts.symbols ?? []).filter((item) => item.localId === jsx.ownerSymbolId);
      const owner = ownerFacts.length === 1 ? ownerFacts[0] : undefined;
      const exactSource = owner ? localNodes.filter((node) => node.type === owner.kind && node.name === owner.name
        && node.qualifiedName === (owner.declaredQualifiedName ?? owner.name)
        && node.startLine === owner.range.startLine && node.endLine === owner.range.endLine) : [];
      const source = (exactSource.length > 0 ? exactSource : localNodes.filter((node) => node.type !== "file" && (node.startLine ?? 0) <= jsx.range.startLine && (node.endLine ?? Number.MAX_SAFE_INTEGER) >= jsx.range.endLine))
        .map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      evidence.push({
        evidenceId: `react-jsx:${materialized.relativePath}:${jsx.id}`,
        framework: "react", adapterId: "react-next", adapterVersion: "1.0.0", strategy: dynamicLocal ? "jsx-dynamic-component-usage" : "jsx-component-usage", capability: "react.component_usage",
        relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: dynamicLocal ? [{ relativePath: materialized.relativePath, inputKey, localId: jsx.id, range: jsx.range }] : refsFor(materialized.relativePath, inputKey), entities: [], applicable: true, supported: !dynamicLocal, attempted: true, state: dynamicLocal ? "unsupported" : "candidate",
        outputKind: "relationship", relationKind: "component_usage", sourceCandidates: source, targetCandidates: targets,
      });
    }
    for (const lookupKey of lookupKeys) dependencies.push({ ...dependency, inputKeys: [inputKey, ...[...(configKeysByLookup.get(lookupKey) ?? [])].sort()], lookupKeys: [lookupKey] });
    if (lookupKeys.length === 0) dependencies.push({ ...dependency, lookupKeys: [] });
    const nextFile = materialized.relativePath;
    const routeMatch = /^(?:app|pages)\/(.*)\/(page|layout|route)\.(?:tsx?|jsx?)$/.exec(nextFile)
      ?? /^(?:app|pages)\/(page|layout|route)\.(?:tsx?|jsx?)$/.exec(nextFile);
    if (routeMatch) {
      const router = nextFile.startsWith("app/") ? "app" : "pages";
      const fileKind = routeMatch[2] ?? routeMatch[1];
      const routeSegments = (routeMatch[2] ? routeMatch[1] : "").split("/").filter((segment) => !/^\([^)]*\)$/.test(segment));
      const routePath = routeSegments.length === 1 && routeSegments[0] === "" ? "/" : `/${routeSegments.join("/")}`;
      const kind = fileKind === "layout" ? "layout" as const : "route" as const;
      const canonical = canonicalizeNextRoute({ framework: "next", scope: "root", router, kind, path: routePath === "/" ? "/" : routePath, method: null, conditions: [], owner: kind === "layout" ? nextFile : null });
      if (canonical.kind === "canonical") {
        const entity = { ref: canonical.ref, displayName: routePath, declarationKey: `route:${nextFile}`, confidence: "exact" as const, refs: refsFor(nextFile, inputKey) };
        const fileNodes = localNodes.filter((node) => node.type === "file").map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
        evidence.push({ evidenceId: `next-route:${nextFile}`, framework: "next", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "next-route-convention", capability: "next.app_routes", relativePath: nextFile, origin: "framework_inferred", confidence: "exact", refs: entity.refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "route_binding", sourceCandidates: fileNodes, targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      }
    }
    const nextDetected = ctx.detections.some((item) => item.framework === "next" && (item.configured || item.observed));
    const directives = nextDetected ? syntax.nodes.filter((node) => node.kind === "directive" && (node.name === "use client" || node.name === "use server")) : [];
    for (const directive of directives) {
      const subjects = localNodes.filter((node) => node.type === "file").map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id }));
      evidence.push({ evidenceId: `next-directive:${nextFile}:${directive.id}`, framework: "next", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "next-execution-directive", capability: "next.execution_boundary", relativePath: nextFile, origin: "framework_inferred", confidence: "exact", refs: refsFor(nextFile, inputKey), entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "classification", classificationKind: "execution_boundary", subjectCandidates: subjects, values: [directive.name === "use client" ? "client" : "server"] });
    }
  }
  return { evidence, dependencies };
}

export const reactNextAdapter: FrameworkSemanticAdapter = {
  id: "react-next",
  version: "1.0.0",
  frameworks: ["react", "next"],
  detect,
  analyze,
};

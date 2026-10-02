import { collectScheduledEvidence } from "../framework-scheduled.js";
import { collectMessageConsumerEvidence } from "../framework-message.js";
import type { ParsedFactsBlob } from "../../facts/facts.types.js";
import type { SyntaxObservation } from "../../facts/objective-syntax.types.js";
import { frameworkEntityKey } from "../framework-identity.js";
import { frameworkEnclosingClass, frameworkGraphSymbol, frameworkImportedName } from "../framework-symbol-binding.js";
import type { DetectionResult, FrameworkAdapterResult, FrameworkAnalysisContext, FrameworkCanonicalRoute, FrameworkCanonicalization, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSubjectRef } from "../framework.types.js";

export function canonicalizeSpringRoute(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  if (input.framework !== "spring") return { kind: "unresolved", code: "framework_construct_unsupported", reason: "not a Spring route" };
  const scope = input.scope;
  const router = input.router;
  const conditions = [...new Set(input.conditions)].sort();
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || input.path.includes("\\") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const ref = { framework: "spring" as const, kind: input.kind, logicalKey: JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]) };
  try { frameworkEntityKey(ref); return { kind: "canonical", ref }; }
  catch { return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" }; }
}

const literal = (node: { kind: string; value?: string | number | boolean | null } | undefined): string | undefined =>
  node?.kind === "literal" && typeof node.value === "string" ? node.value : undefined;

function isConstructorParameter(facts: ParsedFactsBlob, ownerId: string | undefined): boolean | undefined {
  if (!Array.isArray(facts.symbols) || !Array.isArray(facts.containmentScopes)) return undefined;
  const method = facts.symbols.find((item) => item.localId === ownerId && item.kind === "method");
  if (!method) return undefined;
  const scopes = new Map(facts.containmentScopes.map((scope) => [scope.localId, scope]));
  let scopeId = method.scopeId;
  let className: string | undefined;
  while (scopeId) {
    const type = facts.symbols.find((item) => item.kind === "class" && item.scopeId === scopeId);
    if (type) { className = type.name; break; }
    scopeId = scopes.get(scopeId)?.parentId;
  }
  return method.name === "constructor" || method.name === className;
}

function detect(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0]): readonly DetectionResult[] {
  const configured = ctx.config.some((item) => item.kind === "maven" || item.kind === "gradle");
  const observed = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier.startsWith("org.springframework")));
  if (!configured && !observed) return [];
  const graphql = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier.startsWith("org.springframework.graphql.data.method.annotation.")));
  const annotations = ctx.facts.flatMap((item) => item.facts.frameworkSyntax?.nodes.filter((node) => node.kind === "annotation").map((node) => node.name) ?? []);
  const scheduling = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "org.springframework.scheduling.annotation.Scheduled"));
  const kafkaListener = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "org.springframework.kafka.annotation.KafkaListener"));
  const rabbitListener = ctx.facts.some((item) => item.facts.imports.some((value) => value.moduleSpecifier === "org.springframework.amqp.rabbit.annotation.RabbitListener"));
  const capabilities = [
    ...(["RequestMapping", "GetMapping", "PostMapping", "PutMapping", "PatchMapping", "DeleteMapping"].some((name) => annotations.includes(name)) ? ["spring.routes"] : []),
    ...(ctx.facts.some((item) => item.facts.parameters?.some((parameter) => !!parameter.typeText && isConstructorParameter(item.facts, parameter.ownerSymbolId) !== false)) ? ["spring.injection"] : []),
    ...(annotations.includes("Bean") ? ["spring.beans"] : []),
    ...(graphql ? ["spring.graphql"] : []),
    ...(scheduling ? ["spring.scheduling"] : []),
    ...(kafkaListener ? ["spring.kafka_listener"] : []),
    ...(rabbitListener ? ["spring.rabbit_listener"] : []),
  ];
  const refs = ctx.config.filter((item) => item.kind === "maven" || item.kind === "gradle").map((item) => ({ relativePath: item.relativePath, inputKey: item.inputKey }));
  return [{ framework: "spring", scope: "root", configured, observed, capabilities, refs, complete: ctx.config.every((item) => item.complete) }];
}

function mappingAttributes(annotation: SyntaxObservation, nodes: Map<string, SyntaxObservation>, nested: boolean, batch: boolean): { field?: string; parent?: string } | undefined {
  const values = new Map<string, string>();
  for (const argument of annotation.arguments) {
    const name = argument.name ?? "value";
    const node = nodes.get(argument.valueId);
    if (batch && name === "maxBatchSize") {
      if (values.has(name) || node?.kind !== "literal" || typeof node.value !== "number" || !Number.isInteger(node.value) || node.value <= 0) return undefined;
      values.set(name, String(node.value));
      continue;
    }
    if (!(nested ? ["field", "value", "typeName"] : ["name", "value"]).includes(name) || values.has(name)) return undefined;
    const value = literal(node);
    if (value === undefined) return undefined;
    values.set(name, value);
  }
  const field = values.get(nested ? "field" : "name");
  const alias = values.get("value");
  if (field !== undefined && alias !== undefined && field !== alias) return undefined;
  return { field: (field ?? alias) || undefined, parent: values.get("typeName") || undefined };
}

function springSourceParent(facts: ParsedFactsBlob, methodId: string | undefined, batch: boolean): string | undefined {
  const parameters = facts.parameters.filter((item) => item.ownerSymbolId === methodId);
  // Only the single unannotated source parameter is authoritative here.
  if (parameters.length !== 1) return undefined;
  const parameter = parameters[0]!;
  if (facts.frameworkSyntax?.nodes.some((node) => node.kind === "annotation" && node.range.startLine >= parameter.range.startLine
    && node.range.endLine <= parameter.range.endLine && (node.range.startLine !== parameter.range.startLine || (node.range.startColumn ?? 0) >= (parameter.range.startColumn ?? 0)))) return undefined;
  const type = batch ? /^(?:java\.util\.)?List\s*<\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*>$/.exec(parameter.typeText ?? "")?.[1] : parameter.typeText;
  if (!type || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(type)) return undefined;
  const classes = facts.symbols.filter((item) => item.kind === "class" && item.name === type);
  const imports = facts.imports.filter((item) => item.localName === type);
  if (classes.length === 1 && imports.length === 0) return type;
  if (classes.length !== 0 || imports.length !== 1 || imports[0]!.kind !== "named"
    || imports[0]!.moduleSpecifier.startsWith("java.") || imports[0]!.moduleSpecifier.startsWith("org.springframework.")) return undefined;
  return imports[0]!.importedName;
}

function collectSpringGraphqlEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    const imports = materialized.facts.imports;
    const graphqlImport = (name: string | undefined): string | undefined => {
      const imported = imports.filter((item) => item.localName === name);
      if (imported.length !== 1 || !["QueryMapping", "MutationMapping", "SubscriptionMapping", "SchemaMapping", "BatchMapping"].includes(imported[0]!.importedName ?? "")) return undefined;
      return frameworkImportedName(materialized.facts, name, `org.springframework.graphql.data.method.annotation.${imported[0]!.importedName}`);
    };
    if (!imports.some((item) => item.moduleSpecifier.startsWith("org.springframework.graphql.data.method.annotation."))) continue;
    const syntax = materialized.facts.frameworkSyntax;
    if (!syntax) continue;
    const annotations = syntax.nodes.filter((node) => node.kind === "annotation");
    const nodes = new Map(syntax.nodes.map((node) => [node.id, node]));
    const controllers = new Set<string>(annotations.flatMap((item) => {
      const owner = frameworkImportedName(materialized.facts, item.name, "org.springframework.stereotype.Controller") === "Controller"
        ? frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, item.ownerSymbolId, "class") : undefined;
      return owner ? [owner.id] : [];
    }));
    for (const annotation of annotations) {
      const imported = graphqlImport(annotation.name);
      const operationKind = imported === "QueryMapping" ? "query" : imported === "MutationMapping" ? "mutation"
        : imported === "SubscriptionMapping" ? "subscription" : imported === "SchemaMapping" || imported === "BatchMapping" ? "field" : undefined;
      if (!operationKind) {
        const imported = imports.find((item) => item.localName === annotation.name && item.moduleSpecifier.startsWith("org.springframework.graphql.data.method.annotation."));
        if (imported) evidence.push({ evidenceId: `spring-graphql:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.4.0",
          strategy: "controller.import-unsupported", capability: "spring.graphql", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact",
          refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }],
          entities: [], applicable: true, supported: false, attempted: true, state: "unsupported", outputKind: "relationship", relationKind: "graphql_resolver", sourceCandidates: [], targetCandidates: [] });
        continue;
      }
      // Class-level SchemaMapping supplies a type default; it is not a callable entry.
      if (imported === "SchemaMapping" && materialized.facts.symbols.some((item) => item.localId === annotation.ownerSymbolId && item.kind === "class")) continue;
      const owner = frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, "method");
      const ownerClass = frameworkEnclosingClass(ctx, materialized.relativePath, materialized.facts, annotation.ownerSymbolId, owner);
      const methodName = owner?.name ?? materialized.facts.symbols.find((item) => item.localId === annotation.ownerSymbolId && item.kind === "method")?.name;
      const nested = operationKind === "field";
      const attributes = mappingAttributes(annotation, nodes, nested, imported === "BatchMapping");
      const classMappings = annotations.filter((item) => graphqlImport(item.name) === "SchemaMapping"
        && frameworkGraphSymbol(ctx, materialized.relativePath, materialized.facts, item.ownerSymbolId, "class")?.id === ownerClass?.id);
      const classAttributes = classMappings.length === 1 ? mappingAttributes(classMappings[0]!, nodes, true, false) : undefined;
      const parent = nested && attributes ? attributes.parent ?? (classMappings.length === 0 || (classMappings.length === 1 && classAttributes)
        ? classAttributes?.parent ?? springSourceParent(materialized.facts, annotation.ownerSymbolId, imported === "BatchMapping") : undefined) : undefined;
      const fieldName = attributes && (attributes.field ?? methodName);
      const ref = fieldName && (!nested || parent) ? { framework: "spring" as const, kind: nested && !["Query", "Mutation", "Subscription"].includes(parent!) ? "graphql_field" as const : "graphql_operation" as const,
        logicalKey: JSON.stringify(nested ? (["Query", "Mutation", "Subscription"].includes(parent!)
          ? ["root", parent!.toLowerCase(), fieldName] : ["root", parent, fieldName]) : ["root", operationKind, fieldName]) } : undefined;
      let accepted = !!ref && !!ownerClass && controllers.has(ownerClass.id) && syntax.complete
        && !(imported === "BatchMapping" && ["Query", "Mutation", "Subscription"].includes(parent!));
      if (accepted && ref) {
        try { frameworkEntityKey(ref); } catch { accepted = false; }
      }
      const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range },
        ...classMappings.map((item) => ({ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: item.id, range: item.range }))];
      evidence.push({
        evidenceId: `spring-graphql:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.4.0",
        strategy: imported === "BatchMapping" ? "controller.batch-mapping" : imported === "SchemaMapping" ? "controller.schema-mapping"
          : imported === "SubscriptionMapping" ? "controller.subscription-mapping" : "controller.graphql-mapping", capability: "spring.graphql", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs,
        entities: accepted && ref && ownerClass ? [{ ref, displayName: `${operationKind}.${fieldName} (${ownerClass.qualifiedName ?? ownerClass.name})`, declarationKey: `graphql:${materialized.relativePath}:${annotation.id}`, confidence: "exact", refs }] : [],
        applicable: true, supported: true, attempted: true, state: accepted && owner ? "candidate" : "unknown",
        outputKind: "relationship", relationKind: "graphql_resolver",
        sourceCandidates: accepted && owner ? [{ kind: "language", nodeId: owner.id }] : [],
        targetCandidates: accepted && ref ? [{ kind: "framework", entity: ref }] : [],
      });
    }
  }
  return { evidence, dependencies: [] };
}

export function collectSpringBeanEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("org.springframework"))) continue;
    const annotations = materialized.facts.frameworkSyntax?.nodes.filter((node) => node.kind === "annotation" && node.name === "Bean") ?? [];
      const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
      for (const annotation of annotations) {
        const methods = annotation.ownerSymbolId ? graphNodes.filter((node) => node.id === annotation.ownerSymbolId && node.type === "method") : [];
        for (const method of methods) {
          const owners = graphNodes.filter((node) => node.type === "class" && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === method.id));
          evidence.push({ evidenceId: `spring-bean:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.4.0", strategy: "bean.factory-method", capability: "spring.beans", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "bean_relationship", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: [{ kind: "language", nodeId: method.id }] });
        }
      }
      const syntax = materialized.facts.frameworkSyntax;
      const nodes = new Map((syntax?.nodes ?? []).map((node) => [node.id, node]));
      const routeAnnotations: Record<string, string | null> = { RequestMapping: null, GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", PatchMapping: "PATCH", DeleteMapping: "DELETE" };
      const controllerAnnotations = new Set(["RestController", "Controller"]);
      if (!(syntax?.nodes ?? []).some((node) => node.kind === "annotation" && controllerAnnotations.has(node.name ?? ""))) continue;
      for (const annotation of syntax?.nodes ?? []) {
        const method = annotation.name ? routeAnnotations[annotation.name] : undefined;
        if (method === undefined) continue;
        const owner = annotation.ownerSymbolId ? graphNodes.find((node) => node.id === annotation.ownerSymbolId) : undefined;
        if (!owner) continue;
        const ownerClass = graphNodes.find((node) => node.type === "class" && ctx.graph.edges.some((edge) => edge.type === "contains" && edge.from === node.id && edge.to === owner.id));
        const controller = ownerClass && (syntax?.nodes ?? []).find((candidate) => ["RestController", "Controller"].includes(candidate.name ?? "") && candidate.ownerSymbolId === ownerClass.id);
        if (!ownerClass || !controller) continue;
        const classMapping = (syntax?.nodes ?? []).find((candidate) => candidate.name === "RequestMapping" && candidate.ownerSymbolId === ownerClass.id);
        const classPrefix = literal(nodes.get(classMapping?.arguments[0]?.valueId ?? "")) ?? "";
        const argument = annotation.arguments[0];
        const path = argument ? literal(nodes.get(argument.valueId)) : "";
        if (path === undefined) continue;
        const routePath = classPrefix ? `${classPrefix}/${path}` : (path.startsWith("/") ? path : `/${path}`);
        if (routePath.includes("//") || routePath.split("/").some((segment) => segment === "." || segment === "..")) continue;
        const canonical = canonicalizeSpringRoute({ framework: "spring", scope: "root", router: "mvc", kind: "route", path: routePath, method, conditions: [], owner: owner.qualifiedName ?? owner.name });
        if (canonical.kind !== "canonical") continue;
        const refs = [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: annotation.id, range: annotation.range }];
        const entity = { ref: canonical.ref, displayName: canonical.ref.logicalKey, declarationKey: `route:${materialized.relativePath}:${annotation.id}`, confidence: "exact" as const, refs };
        evidence.push({ evidenceId: `spring-route:${materialized.relativePath}:${annotation.id}`, framework: "spring", adapterId: "spring", adapterVersion: "1.4.0", strategy: "request-mapping", capability: "spring.routes", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs, entities: [entity], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "controller_route", sourceCandidates: [{ kind: "language", nodeId: owner.id }], targetCandidates: [{ kind: "framework", entity: canonical.ref }] });
      }
  }
  return { evidence, dependencies: [] };
}

export function collectSpringInjectionEvidence(ctx: FrameworkAnalysisContext): FrameworkAdapterResult {
  const evidence: FrameworkEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!materialized.facts.imports.some((item) => item.moduleSpecifier.startsWith("org.springframework"))) continue;
    const graphNodes = ctx.graph.nodes.filter((node) => node.file === materialized.relativePath);
    for (const parameter of materialized.facts.parameters ?? []) {
      if (!parameter.typeText || !parameter.ownerSymbolId) continue;
      if (isConstructorParameter(materialized.facts, parameter.ownerSymbolId) === false) continue;
      const owners = graphNodes.filter((node) => node.id === parameter.ownerSymbolId);
      const providers = ctx.graph.nodes.filter((node) => node.type !== "file" && node.name === parameter.typeText);
      evidence.push({ evidenceId: `spring-inject:${materialized.relativePath}:${parameter.localId}`, framework: "spring", adapterId: "spring", adapterVersion: "1.4.0", strategy: "autowired.constructor", capability: "spring.injection", relativePath: materialized.relativePath, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: materialized.relativePath, inputKey: `facts:${materialized.relativePath}`, localId: parameter.localId, range: parameter.range }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "dependency_injection", sourceCandidates: owners.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })), targetCandidates: providers.map((node): FrameworkSubjectRef => ({ kind: "language", nodeId: node.id })) });
    }
  }
  return { evidence, dependencies: [] };
}

export const springAdapter: FrameworkSemanticAdapter = {
  id: "spring", version: "1.4.0", frameworks: ["spring"], detect,
  analyze: (ctx: FrameworkAnalysisContext): FrameworkAdapterResult => {
    const beans = collectSpringBeanEvidence(ctx);
    const injection = collectSpringInjectionEvidence(ctx);
    const graphql = collectSpringGraphqlEvidence(ctx);
    return { evidence: [...beans.evidence, ...injection.evidence, ...graphql.evidence, ...collectScheduledEvidence(ctx, "spring"), ...collectMessageConsumerEvidence(ctx, "spring")], dependencies: [...beans.dependencies, ...injection.dependencies, ...graphql.dependencies, ...ctx.facts.filter((f) => ctx.analyzePaths.has(f.relativePath) && (f.facts.imports.some((i) => i.moduleSpecifier === "org.springframework.scheduling.annotation.Scheduled") || f.facts.imports.some((i) => i.moduleSpecifier === "org.springframework.kafka.annotation.KafkaListener" || i.moduleSpecifier === "org.springframework.amqp.rabbit.annotation.RabbitListener"))).map((f) => ({ framework: "spring" as const, scope: "root", ownerPath: f.relativePath, inputKeys: [`facts:${f.relativePath}`], lookupKeys: [], complete: f.facts.frameworkSyntax?.complete === true }))] };
  },
};

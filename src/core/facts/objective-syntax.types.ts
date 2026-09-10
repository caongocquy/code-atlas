import type { FactLocalId, SourceRangeFact } from "./facts.types.js";

export type SyntaxObservationKind =
  | "annotation" | "directive" | "jsx" | "identifier" | "literal"
  | "object" | "array" | "property" | "call" | "construct"
  | "lambda" | "return" | "spread" | "unknown";

export type SyntaxObservation = {
  id: string;
  kind: SyntaxObservationKind;
  range: SourceRangeFact;
  ownerSymbolId?: FactLocalId;
  ownerScopeId?: FactLocalId;
  factId?: FactLocalId;
  name?: string;
  value?: string | number | boolean | null;
  children: readonly string[];
  arguments: readonly { name?: string; valueId: string }[];
  receiverId?: string;
  typeArguments: readonly string[];
};

export type ObjectiveSyntax = {
  nodes: readonly SyntaxObservation[];
  complete: boolean;
};

type SyntaxNode = {
  type: string;
  text: string;
  isMissing?: boolean;
  parent?: SyntaxNode | null;
  children: readonly SyntaxNode[];
  namedChildren: readonly SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
};

type MutableObservation = SyntaxObservation & {
  children: string[];
  arguments: Array<{ name?: string; valueId: string }>;
  typeArguments: string[];
};

const range = (node: SyntaxNode): SourceRangeFact => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + 1,
  startColumn: node.startPosition.column,
  endColumn: node.endPosition.column,
});

function isDirective(node: SyntaxNode): boolean {
  if (node.type !== "expression_statement" || node.namedChildren[0]?.type !== "string") return false;
  const parent = node.parent;
  if (!parent) return false;
  const index = parent.namedChildren.indexOf(node);
  return index >= 0 && parent.namedChildren.slice(0, index).every((item) => item.type === "expression_statement" && item.namedChildren[0]?.type === "string");
}

function descendants(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.flatMap((child) => [child, ...descendants(child)]);
}

function firstDescendant(node: SyntaxNode, predicate: (candidate: SyntaxNode) => boolean): SyntaxNode | undefined {
  return descendants(node).find(predicate);
}

function isIdentifier(node: SyntaxNode): boolean {
  return node.type.includes("identifier");
}

function isDartGenericInvocation(node: SyntaxNode): boolean {
  return node.type === "relational_expression"
    && node.namedChildren[0]?.type === "relational_expression"
    && node.namedChildren.at(-1)?.type === "record_literal";
}

function previousNamedSibling(node: SyntaxNode): SyntaxNode | undefined {
  const siblings = node.parent?.namedChildren;
  if (!siblings) return undefined;
  const index = siblings.indexOf(node);
  return index > 0 ? siblings[index - 1] : undefined;
}

function isDartInvocationSelector(node: SyntaxNode): boolean {
  return node.type === "selector" && node.namedChildren.some((child) => child.type === "argument_part");
}

function dartSelectorName(node: SyntaxNode): string | undefined {
  const member = node.namedChildren.find((child) => child.type.includes("assignable_selector"));
  const ownName = member ? firstDescendant(member, isIdentifier) : undefined;
  if (ownName) return ownName.text;
  const previous = previousNamedSibling(node);
  return previous?.type === "selector" ? dartSelectorName(previous) : previous?.text;
}

const nodeKey = (node: SyntaxNode): string => `${node.type}:${node.startIndex}:${node.endIndex}`;

function kindFor(node: SyntaxNode): SyntaxObservationKind | undefined {
  const { type } = node;
  if (isDirective(node)) return "directive";
  if (node.isMissing || type === "ERROR" || type.includes("computed")) return "unknown";
  if (type.includes("annotation") || type === "decorator") return "annotation";
  if (type === "jsx_opening_element" || type === "jsx_self_closing_element") return "jsx";
  if (type === "arrow_function" || type.includes("lambda") || type === "anonymous_function" || type === "function_expression") return "lambda";
  if (type === "return_expression" || type === "return_statement") return "return";
  if (type.includes("spread")) return "spread";
  if (type === "object" || type.includes("object_literal") || type.includes("map_literal") || type === "set_or_map_literal") return "object";
  if (type.includes("array") || type.includes("list_literal")) return "array";
  if (type === "pair" || type.includes("property") || type === "map_entry" || type === "record_field" || (type === "selector" && !isDartInvocationSelector(node))) return "property";
  if (type === "new_expression" || type === "object_creation_expression" || type === "constructor_invocation") return "construct";
  if (type === "call_expression" || type === "method_invocation" || isDartInvocationSelector(node) || isDartGenericInvocation(node)) return "call";
  if (isIdentifier(node)) return "identifier";
  if (type === "string" || type.includes("string_literal") || type.includes("number") || type.includes("integer") || type.includes("decimal") || type === "true" || type === "false" || type === "null") return "literal";
  return undefined;
}

function literalValue(node: SyntaxNode): SyntaxObservation["value"] | undefined {
  if (node.type === "true") return true;
  if (node.type === "false") return false;
  if (node.type === "null") return null;
  if (node.type.includes("number") || node.type.includes("integer") || node.type.includes("decimal")) {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (node.type === "string" || node.type.includes("string_literal")) {
    if (node.text.startsWith('"')) {
      try { return JSON.parse(node.text); } catch { /* Preserve the parser-proven raw literal below. */ }
    }
    if (node.text.length < 2) return node.text;
    return node.text.slice(1, -1).replace(/\\([\\'"bfnrt])/g, (_match, escaped: string) => ({
      "\\": "\\",
      "'": "'",
      "\"": "\"",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    })[escaped] ?? escaped);
  }
  return undefined;
}

export function createObjectiveSyntaxCollector() {
  const nodes: MutableObservation[] = [];
  const byNode = new Map<string, MutableObservation>();
  const byId = new Map<string, MutableObservation>();
  const entries: Array<{ source: SyntaxNode; observation: MutableObservation }> = [];
  const pendingFacts = new Map<string, FactLocalId>();
  const pendingOwners = new Map<string, FactLocalId>();
  let sequence = 0;

  const inheritedLink = (node: SyntaxNode, links: ReadonlyMap<string, FactLocalId>): FactLocalId | undefined => {
    for (let current: SyntaxNode | null | undefined = node; current; current = current.parent) {
      const value = links.get(nodeKey(current));
      if (value) return value;
    }
    return undefined;
  };

  const nearestObservations = (node: SyntaxNode): MutableObservation[] => {
    const exact = byNode.get(nodeKey(node));
    if (exact) return [exact];
    return node.namedChildren.flatMap(nearestObservations);
  };

  const argumentContainer = (node: SyntaxNode): SyntaxNode | undefined =>
    node.childForFieldName("arguments") ?? firstDescendant(node, (candidate) =>
      ["arguments", "argument_list", "annotation_argument_list", "value_arguments", "record_literal"].includes(candidate.type));

  const argumentParts = (item: SyntaxNode): { name?: string; value: SyntaxNode } => {
    const key = item.childForFieldName("key");
    const value = item.childForFieldName("value");
    if (value) return { name: key?.text, value };
    if (["named_argument", "record_field"].includes(item.type)) {
      const label = item.namedChildren.find((child) => child.type === "label");
      return { name: firstDescendant(label ?? item, isIdentifier)?.text, value: item.namedChildren.at(-1) ?? item };
    }
    if (item.type === "value_argument" && item.text.includes("=") && item.namedChildren.length > 1) {
      return { name: item.namedChildren[0]?.text, value: item.namedChildren.at(-1)! };
    }
    return { value: item };
  };

  const observationName = (node: SyntaxNode, kind: SyntaxObservationKind): string | undefined => {
    if (kind === "identifier") return node.text;
    if (kind === "unknown" && node.type.includes("computed")) return "computed";
    if (kind === "directive") {
      const literal = node.namedChildren[0];
      const value = literal ? literalValue(literal) : undefined;
      return typeof value === "string" ? value : undefined;
    }
    if (kind === "property") {
      if (node.type === "selector") return dartSelectorName(node);
      const key = node.childForFieldName("key");
      if (key && !key.type.includes("computed")) return key.text;
      if (node.type === "record_field") return firstDescendant(node.namedChildren[0] ?? node, isIdentifier)?.text;
      if (isIdentifier(node)) return node.text;
    }
    if (kind === "jsx") return node.childForFieldName("name")?.text;
    if (kind === "annotation") {
      const name = node.childForFieldName("name") ?? firstDescendant(node, isIdentifier);
      return name?.text;
    }
    if (kind === "call" || kind === "construct") {
      if (node.type === "selector") return dartSelectorName(node);
      if (isDartGenericInvocation(node)) return firstDescendant(node.namedChildren[0]!, isIdentifier)?.text;
      const callable = node.childForFieldName("function") ?? node.childForFieldName("constructor") ?? node.childForFieldName("type");
      if (callable?.type === "member_expression" || callable?.type === "field_access") {
        return callable.childForFieldName("property")?.text ?? callable.childForFieldName("field")?.text;
      }
      return node.childForFieldName("name")?.text ?? firstDescendant(callable ?? node, isIdentifier)?.text;
    }
    return undefined;
  };

  const observe = (
    node: SyntaxNode,
    ownerSymbolId?: FactLocalId,
    ownerScopeId?: FactLocalId,
  ): MutableObservation | undefined => {
    const kind = kindFor(node);
    if (!kind) return undefined;
    const observation: MutableObservation = {
      id: `syntax:${++sequence}`,
      kind,
      range: range(node),
      ownerSymbolId: ownerSymbolId ?? inheritedLink(node, pendingOwners),
      ownerScopeId,
      factId: inheritedLink(node, pendingFacts),
      name: observationName(node, kind),
      value: kind === "literal" ? literalValue(node) : undefined,
      children: [],
      arguments: [],
      typeArguments: [],
    };
    nodes.push(observation);
    byNode.set(nodeKey(node), observation);
    byId.set(observation.id, observation);
    entries.push({ source: node, observation });
    let linked = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      const parentObservation = byNode.get(nodeKey(parent));
      if (!parentObservation) continue;
      if (!linked) parentObservation.children.push(observation.id);
      if (!linked && (parentObservation.kind === "annotation" || parentObservation.kind === "call" || parentObservation.kind === "construct")) {
        parentObservation.arguments.push({ valueId: observation.id });
      }
      if (parentObservation.kind === "annotation" && observation.kind === "identifier" && parentObservation.name === undefined) parentObservation.name = observation.name;
      if (parentObservation.kind === "jsx" && observation.kind === "identifier" && parentObservation.name === undefined) parentObservation.name = observation.name;
      linked = true;
    }
    return observation;
  };

  const linkFact = (node: SyntaxNode, factId: FactLocalId | undefined): void => {
    if (!factId) return;
    pendingFacts.set(nodeKey(node), factId);
    const observation = byNode.get(nodeKey(node));
    if (observation) observation.factId = factId;
  };

  const linkOwner = (node: SyntaxNode, ownerSymbolId: FactLocalId | undefined): void => {
    if (!ownerSymbolId) return;
    pendingOwners.set(nodeKey(node), ownerSymbolId);
    const observation = byNode.get(nodeKey(node));
    if (observation) observation.ownerSymbolId = ownerSymbolId;
  };

  const finish = (complete: boolean, fallbackNode?: SyntaxNode): ObjectiveSyntax | undefined => {
    if (nodes.length === 0 && complete) return undefined;
    if (nodes.length === 0) {
      const unknown: MutableObservation = {
        id: `syntax:${++sequence}`,
        kind: "unknown",
        range: fallbackNode ? range(fallbackNode) : { startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 },
        children: [], arguments: [], typeArguments: [],
      };
      nodes.push(unknown);
      byId.set(unknown.id, unknown);
    }
    for (const { source, observation } of entries) {
      if (observation.kind === "property") {
        const value = argumentParts(source).value;
        if (value !== source) observation.children = nearestObservations(value).map((item) => item.id);
        observation.children = observation.children.filter((id) => id !== observation.id);
        if (source.type === "selector") {
          const receiver = previousNamedSibling(source);
          observation.receiverId = receiver ? nearestObservations(receiver)[0]?.id : undefined;
        }
      }
      if (observation.kind === "annotation" || observation.kind === "call" || observation.kind === "construct") {
        const container = argumentContainer(source);
        observation.arguments = (container?.namedChildren ?? []).flatMap((item) => {
          const part = argumentParts(item);
          const value = nearestObservations(part.value)[0];
          return value && value.id !== observation.id ? [{ name: part.name, valueId: value.id }] : [];
        });
      }
      if (observation.kind === "call" || observation.kind === "construct") {
        const callable = source.childForFieldName("function");
        const receiver = callable?.childForFieldName("object")
          ?? source.childForFieldName("object")
          ?? (source.type === "selector" ? previousNamedSibling(source) : undefined);
        observation.receiverId = receiver ? nearestObservations(receiver)[0]?.id : undefined;
        const typeArguments = source.childForFieldName("type_arguments")
          ?? firstDescendant(source, (candidate) => candidate.type === "type_arguments");
        observation.typeArguments = typeArguments
          ? nearestObservations(typeArguments).filter((item) => item.kind === "identifier").map((item) => item.id)
          : [];
        if (isDartGenericInvocation(source)) {
          const generic = source.namedChildren[0]!;
          observation.typeArguments = nearestObservations(generic).filter((item) => item.name !== observation.name).map((item) => item.id);
        }
      }
      if (observation.kind === "lambda" && !observation.children.some((id) => byId.get(id)?.kind === "return")) {
        const body = source.childForFieldName("body");
        const values = body ? nearestObservations(body) : [];
        if (body && values.length > 0) {
          const result: MutableObservation = {
            id: `syntax:${++sequence}`,
            kind: "return",
            range: range(body),
            ownerSymbolId: observation.ownerSymbolId,
            ownerScopeId: observation.ownerScopeId,
            children: values.map((item) => item.id),
            arguments: [],
            typeArguments: [],
          };
          const valueIds = new Set(result.children);
          observation.children = [...observation.children.filter((id) => !valueIds.has(id)), result.id];
          nodes.push(result);
          byId.set(result.id, result);
        }
      }
      if (observation.kind === "lambda" && !observation.children.some((id) => byId.get(id)?.kind === "return")) {
        const body = source.childForFieldName("body");
        const values = body ? nearestObservations(body) : [];
        if (body && values.length > 0) {
          const result: MutableObservation = {
            id: `syntax:${++sequence}`,
            kind: "return",
            range: range(body),
            ownerSymbolId: observation.ownerSymbolId,
            ownerScopeId: observation.ownerScopeId,
            children: values.map((item) => item.id),
            arguments: [],
            typeArguments: [],
          };
          const valueIds = new Set(result.children);
          observation.children = [...observation.children.filter((id) => !valueIds.has(id)), result.id];
          nodes.push(result);
          byId.set(result.id, result);
        }
      }
    }
    return { nodes, complete };
  };

  return { observe, linkFact, linkOwner, finish, byId };
}

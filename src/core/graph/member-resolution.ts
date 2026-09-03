import Parser from "tree-sitter";

import { getLanguageAdapter } from "./parsers/registry.js";
import type { CallReference } from "./calls.js";
import type { ImportBinding } from "./import-bindings.js";
import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

export type ObjectBinding = {
  localName: string;
  className: string;
  targetFile?: string;
};

export type ParameterBinding = {
  callerQualifiedName: string;
  localName: string;
  className: string;
  targetFile?: string;
};

export type ClassFieldBinding = {
  ownerClassName: string;
  fieldName: string;
  className: string;
  targetFile?: string;
};

type MemberCallPath = {
  root: string;
  members: string[];
  constructedClassName?: string;
};

function parseMemberCallPath(calleeName: string): MemberCallPath | undefined {
  const directNewMatch = calleeName.match(
    /^new\s+([A-Za-z_$][\w$]*)\s*\(\)\.([A-Za-z_$][\w$]*)$/,
  );

  if (directNewMatch?.[1] && directNewMatch[2]) {
    return {
      root: directNewMatch[1],
      members: [directNewMatch[2]],
      constructedClassName: directNewMatch[1],
    };
  }

  const parts = calleeName
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return undefined;
  }

  const [root, ...members] = parts;

  if (!root || members.length === 0) {
    return undefined;
  }

  return {
    root,
    members,
  };
}

function resolveClassBinding(
  typeName: string,
  filePath: string,
  importByLocalName: Map<string, ImportBinding>,
): {
  className: string;
  targetFile?: string;
} {
  const importBinding = importByLocalName.get(typeName);

  if (importBinding) {
    return {
      className: importBinding.importedName,
      targetFile: importBinding.targetFile,
    };
  }

  return {
    className: typeName,
    targetFile: filePath,
  };
}

function createParser(filePath: string): Parser | undefined {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter) {
    return undefined;
  }

  const parser = new Parser();

  parser.setLanguage(adapter.grammar);

  return parser;
}

function extractObjectBindings(
  source: string,
  filePath: string,
  importBindings: ImportBinding[],
): ObjectBinding[] {
  const parser = createParser(filePath);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(source);

  const importByLocalName = new Map(
    importBindings.map((binding) => [binding.localName, binding]),
  );

  const results: ObjectBinding[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");

      const valueNode = node.childForFieldName("value");

      if (
        nameNode?.type === "identifier" &&
        valueNode?.type === "new_expression"
      ) {
        const constructorNode = valueNode.childForFieldName("constructor");

        if (constructorNode?.type === "identifier") {
          const resolved = resolveClassBinding(
            constructorNode.text,
            filePath,
            importByLocalName,
          );

          results.push({
            localName: nameNode.text,
            className: resolved.className,
            targetFile: resolved.targetFile,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return results;
}

function findContainingClassName(node: Parser.SyntaxNode): string | undefined {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (current.type === "class_declaration") {
      return current.childForFieldName("name")?.text;
    }

    current = current.parent;
  }

  return undefined;
}

function getCallableQualifiedName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "function_declaration") {
    return node.childForFieldName("name")?.text;
  }

  if (node.type === "method_definition") {
    const methodName = node.childForFieldName("name")?.text;

    if (!methodName) {
      return undefined;
    }

    const className = findContainingClassName(node);

    return className ? `${className}.${methodName}` : methodName;
  }

  return undefined;
}

function extractParameterType(parameter: Parser.SyntaxNode): {
  localName?: string;
  typeName?: string;
} {
  const patternNode =
    parameter.childForFieldName("pattern") ??
    parameter.childForFieldName("name");

  const typeNode = parameter.childForFieldName("type");

  if (patternNode?.type === "identifier" && typeNode) {
    const typeName = typeNode.text.replace(/^:\s*/, "").trim();

    if (/^[A-Za-z_$][\w$]*$/.test(typeName)) {
      return {
        localName: patternNode.text,
        typeName,
      };
    }
  }

  const match = parameter.text.match(
    /^([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$]*)/,
  );

  if (!match) {
    return {};
  }

  return {
    localName: match[1],
    typeName: match[2],
  };
}

function extractParameterBindings(
  source: string,
  filePath: string,
  importBindings: ImportBinding[],
): ParameterBinding[] {
  const parser = createParser(filePath);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(source);

  const importByLocalName = new Map(
    importBindings.map((binding) => [binding.localName, binding]),
  );

  const results: ParameterBinding[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition"
    ) {
      const callerQualifiedName = getCallableQualifiedName(node);

      const parameters = node.childForFieldName("parameters");

      if (callerQualifiedName && parameters) {
        for (const parameter of parameters.namedChildren) {
          const { localName, typeName } = extractParameterType(parameter);

          if (!localName || !typeName) {
            continue;
          }

          const resolved = resolveClassBinding(
            typeName,
            filePath,
            importByLocalName,
          );

          results.push({
            callerQualifiedName,
            localName,
            className: resolved.className,
            targetFile: resolved.targetFile,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return results;
}

function extractClassFieldBindings(
  source: string,
  filePath: string,
  importBindings: ImportBinding[],
): ClassFieldBinding[] {
  const parser = createParser(filePath);

  if (!parser) {
    return [];
  }

  const tree = parser.parse(source);

  const importByLocalName = new Map(
    importBindings.map((binding) => [binding.localName, binding]),
  );

  const results: ClassFieldBinding[] = [];

  function addBinding(
    ownerClassName: string | undefined,
    fieldName: string | undefined,
    parameter: Parser.SyntaxNode,
  ): void {
    const { typeName } = extractParameterType(parameter);

    if (!ownerClassName || !fieldName || !typeName) {
      return;
    }

    const resolved = resolveClassBinding(
      typeName,
      filePath,
      importByLocalName,
    );

    results.push({
      ownerClassName,
      fieldName,
      className: resolved.className,
      targetFile: resolved.targetFile,
    });
  }

  function walk(node: Parser.SyntaxNode): void {
    if (
      node.type === "method_definition" &&
      node.childForFieldName("name")?.text === "constructor"
    ) {
      const ownerClassName = findContainingClassName(node);
      const parameters = node.childForFieldName("parameters");

      for (const parameter of parameters?.namedChildren ?? []) {
        if (
          !parameter.namedChildren.some(
            (child) => child.type === "accessibility_modifier",
          )
        ) {
          continue;
        }

        const { localName } = extractParameterType(parameter);

        addBinding(ownerClassName, localName, parameter);
      }
    }

    if (node.type === "public_field_definition") {
      const ownerClassName = findContainingClassName(node);

      const nameNode = node.childForFieldName("name");

      const typeNode = node.childForFieldName("type");

      if (
        ownerClassName &&
        nameNode?.type === "property_identifier" &&
        typeNode
      ) {
        const typeName = typeNode.text.replace(/^:\s*/, "").trim();

        if (/^[A-Za-z_$][\w$]*$/.test(typeName)) {
          const resolved = resolveClassBinding(
            typeName,
            filePath,
            importByLocalName,
          );

          results.push({
            ownerClassName,
            fieldName: nameNode.text,
            className: resolved.className,
            targetFile: resolved.targetFile,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return results;
}

function findCallerNode(
  graph: CodeGraph,
  file: string,
  call: CallReference,
): GraphNode | undefined {
  if (!call.callerName || !call.callerType) {
    return undefined;
  }

  if (call.callerQualifiedName) {
    const qualifiedMatch = graph.nodes.find(
      (node) =>
        node.file === file &&
        node.type === call.callerType &&
        node.qualifiedName === call.callerQualifiedName,
    );

    if (qualifiedMatch) {
      return qualifiedMatch;
    }
  }

  return graph.nodes.find(
    (node) =>
      node.file === file &&
      node.name === call.callerName &&
      node.type === call.callerType,
  );
}

function findMethodNode(
  graph: CodeGraph,
  targetFile: string,
  className: string,
  methodName: string,
): GraphNode | undefined {
  const qualifiedName = `${className}.${methodName}`;

  return graph.nodes.find(
    (node) =>
      node.file === targetFile &&
      node.type === "method" &&
      node.qualifiedName === qualifiedName,
  );
}

function createEdge(callerNode: GraphNode, methodNode: GraphNode): GraphEdge {
  return {
    from: callerNode.id,
    to: methodNode.id,
    type: "calls",
  };
}

export function resolveMemberCallEdges(
  graph: CodeGraph,
  file: string,
  source: string,
  calls: CallReference[],
  importBindings: ImportBinding[],
): GraphEdge[] {
  const objectBindings = extractObjectBindings(source, file, importBindings);

  const parameterBindings = extractParameterBindings(
    source,
    file,
    importBindings,
  );

  const classFieldBindings = extractClassFieldBindings(
    source,
    file,
    importBindings,
  );

  const importByLocalName = new Map(
    importBindings.map((binding) => [binding.localName, binding]),
  );

  const objectByLocalName = new Map(
    objectBindings.map((binding) => [binding.localName, binding]),
  );

  const parameterByScope = new Map(
    parameterBindings.map((binding) => [
      [binding.callerQualifiedName, binding.localName].join(":"),
      binding,
    ]),
  );

  const fieldByClass = new Map(
    classFieldBindings.map((binding) => [
      [binding.ownerClassName, binding.fieldName].join(":"),
      binding,
    ]),
  );

  const edges: GraphEdge[] = [];

  const seen = new Set<string>();

  function pushEdge(edge: GraphEdge): void {
    const key = [edge.from, edge.to, edge.type].join(":");

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    edges.push(edge);
  }

  for (const call of calls) {
    const callerNode = findCallerNode(graph, file, call);

    if (!callerNode) {
      continue;
    }

    const memberPath = parseMemberCallPath(call.calleeName);

    if (!memberPath) {
      continue;
    }

    if (memberPath.constructedClassName && memberPath.members.length === 1) {
      const resolved = resolveClassBinding(
        memberPath.constructedClassName,
        file,
        importByLocalName,
      );
      const methodName = memberPath.members[0];

      if (!methodName || !resolved.targetFile) {
        continue;
      }

      const methodNode = findMethodNode(
        graph,
        resolved.targetFile,
        resolved.className,
        methodName,
      );

      if (methodNode) {
        pushEdge(createEdge(callerNode, methodNode));
      }

      continue;
    }

    //
    // this.method()
    //

    if (memberPath.root === "this" && memberPath.members.length === 1) {
      const methodName = memberPath.members[0];

      if (!methodName || !call.callerClassName) {
        continue;
      }

      const methodNode = findMethodNode(
        graph,
        file,
        call.callerClassName,
        methodName,
      );

      if (!methodNode) {
        continue;
      }

      pushEdge(createEdge(callerNode, methodNode));

      continue;
    }

    //
    // this.field.method()
    //

    if (memberPath.root === "this" && memberPath.members.length === 2) {
      const [fieldName, methodName] = memberPath.members;

      if (!fieldName || !methodName || !call.callerClassName) {
        continue;
      }

      const fieldBinding = fieldByClass.get(
        [call.callerClassName, fieldName].join(":"),
      );

      if (!fieldBinding || !fieldBinding.targetFile) {
        continue;
      }

      const methodNode = findMethodNode(
        graph,
        fieldBinding.targetFile,
        fieldBinding.className,
        methodName,
      );

      if (!methodNode) {
        continue;
      }

      pushEdge(createEdge(callerNode, methodNode));

      continue;
    }

    //
    // object.method()
    //

    if (memberPath.members.length !== 1) {
      continue;
    }

    const objectName = memberPath.root;

    const methodName = memberPath.members[0];

    if (!objectName || !methodName) {
      continue;
    }

    let className: string | undefined;

    let targetFile: string | undefined;

    //
    // Typed parameter.
    //

    if (call.callerQualifiedName) {
      const parameterBinding = parameterByScope.get(
        [call.callerQualifiedName, objectName].join(":"),
      );

      if (parameterBinding) {
        className = parameterBinding.className;

        targetFile = parameterBinding.targetFile;
      }
    }

    //
    // Local object created with `new`.
    //

    if (!className || !targetFile) {
      const objectBinding = objectByLocalName.get(objectName);

      if (objectBinding) {
        className = objectBinding.className;

        targetFile = objectBinding.targetFile;
      }
    }

    if (!className || !targetFile) {
      continue;
    }

    const methodNode = findMethodNode(graph, targetFile, className, methodName);

    if (!methodNode) {
      continue;
    }

    pushEdge(createEdge(callerNode, methodNode));
  }

  return edges;
}

import type { GraphNode } from "./types";

export type SigmaNodeAttributes = {
  x: number;
  y: number;
  size: number;
  label: string;
  nodeType: string;
  degree: number;
  color: string;
};

export function toSigmaNodeAttributes(
  node: GraphNode,
  point: { x: number; y: number },
  size: number,
  degree: number,
  color: string,
): SigmaNodeAttributes {
  return {
    x: point.x,
    y: point.y,
    size,
    label: node.name,
    nodeType: node.type,
    degree,
    color,
  };
}

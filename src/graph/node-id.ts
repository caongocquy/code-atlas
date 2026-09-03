import { v5 as uuidv5 } from "uuid";

import { POINT_NAMESPACE } from "../config/constants.js";
import type { GraphNodeType } from "./types.js";

export function createGraphNodeId(
  repoId: string,
  file: string,
  type: GraphNodeType,
  qualifiedName: string,
): string {
  const identity = ["graph", repoId, file, type, qualifiedName].join(":");

  return uuidv5(identity, POINT_NAMESPACE);
}

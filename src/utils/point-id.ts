import { v5 as uuidv5 } from "uuid";

import { POINT_NAMESPACE } from "../config/constants.js";

export function createPointId(
  repoId: string,
  relativePath: string,
  symbolType: string,
  symbolName: string,
  part = 1,
  generationId: string,
): string {
  return uuidv5(
    [repoId, relativePath, symbolType, symbolName, part, generationId].join(
      ":",
    ),
    POINT_NAMESPACE,
  );
}

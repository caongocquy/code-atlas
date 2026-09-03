import { REPO_CODE_COLLECTION } from "../config/constants.js";
import { embed } from "../lib/embedding.js";
import { qdrant } from "../lib/qdrant.js";

export type SearchResult = {
  score: number;
  repoId?: string;
  file?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
};

export async function searchCode(
  query: string,
  limit = 5,
): Promise<SearchResult[]> {
  const queryVector = await embed(query);

  const result = await qdrant.query(REPO_CODE_COLLECTION, {
    query: queryVector,
    limit,
    with_payload: true,
  });

  return result.points.map((point) => ({
    score: point.score,
    repoId:
      typeof point.payload?.repoId === "string"
        ? point.payload.repoId
        : undefined,
    file:
      typeof point.payload?.file === "string" ? point.payload.file : undefined,
    symbolName:
      typeof point.payload?.symbolName === "string"
        ? point.payload.symbolName
        : undefined,
    symbolType:
      typeof point.payload?.symbolType === "string"
        ? point.payload.symbolType
        : undefined,
    startLine:
      typeof point.payload?.startLine === "number"
        ? point.payload.startLine
        : undefined,
    endLine:
      typeof point.payload?.endLine === "number"
        ? point.payload.endLine
        : undefined,
    content:
      typeof point.payload?.content === "string"
        ? point.payload.content
        : undefined,
  }));
}

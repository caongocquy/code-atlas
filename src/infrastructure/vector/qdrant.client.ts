import { QdrantClient } from "@qdrant/js-client-rest";
import { QDRANT_URL } from "../../config/constants.js";

export const qdrant = new QdrantClient({
  url: QDRANT_URL,
});

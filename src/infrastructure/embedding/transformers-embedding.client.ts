import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import { EMBEDDING_MODEL } from "../../config/constants.js";

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL);
  }

  return embedderPromise;
}

export async function warmupEmbedding(): Promise<void> {
  await getEmbedder();
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);

  if (!vector) {
    throw new Error("Embedding model returned no vector");
  }

  return vector;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const embedder = await getEmbedder();

  const output = await embedder(texts, {
    pooling: "mean",
    normalize: true,
  });

  const data = Array.from(output.data) as number[];

  const dimensions = data.length / texts.length;

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Unexpected embedding output shape: ${JSON.stringify(output.dims)}`,
    );
  }

  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += 1) {
    const start = index * dimensions;

    const end = start + dimensions;

    vectors.push(data.slice(start, end));
  }

  return vectors;
}

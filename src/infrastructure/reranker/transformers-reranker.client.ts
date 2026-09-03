import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
} from "@huggingface/transformers";

const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null =
  null;

let modelPromise: ReturnType<
  typeof AutoModelForSequenceClassification.from_pretrained
> | null = null;

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = AutoTokenizer.from_pretrained(RERANK_MODEL);
  }

  return tokenizerPromise;
}

function getModel() {
  if (!modelPromise) {
    modelPromise =
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL);
  }

  return modelPromise;
}

export async function warmupReranker(): Promise<void> {
  await Promise.all([getTokenizer(), getModel()]);
}

export type RerankCandidate = {
  file?: string;
  symbolName?: string;
  symbolType?: string;
  content?: string;
};

export type RerankedCandidate<T extends RerankCandidate> = T & {
  rerankScore: number;
};

function buildRerankDocument(candidate: RerankCandidate): string {
  return [
    candidate.file ? `File: ${candidate.file}` : "",
    candidate.symbolType ? `Type: ${candidate.symbolType}` : "",
    candidate.symbolName ? `Symbol: ${candidate.symbolName}` : "",
    "",
    candidate.content ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  limit = 5,
): Promise<RerankedCandidate<T>[]> {
  if (candidates.length === 0) {
    return [];
  }

  const [tokenizer, model] = await Promise.all([getTokenizer(), getModel()]);

  const queries = candidates.map(() => query);

  const documents = candidates.map(buildRerankDocument);

  const features = tokenizer(queries, {
    text_pair: documents,
    padding: true,
    truncation: true,
  });

  const output = await model(features);

  const values = Array.from(output.logits.ort_tensor.cpuData as Float32Array);

  return candidates
    .map((candidate, index) => ({
      ...candidate,
      rerankScore: values[index] ?? Number.NEGATIVE_INFINITY,
    }))
    .sort((a, b) => b.rerankScore - a.rerankScore)
    .slice(0, limit);
}

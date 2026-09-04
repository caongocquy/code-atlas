import { AutoTokenizer } from "@huggingface/transformers";

import { EMBEDDING_MODEL } from "../../config/constants.js";

let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null = null;

async function getTokenizer() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(EMBEDDING_MODEL);
  return tokenizerPromise;
}

export async function countTokens(
  text: string,
  options: { useModel?: boolean } = {},
): Promise<number> {
  if (options.useModel === false) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  const tokenizer = await getTokenizer();
  const encoded = tokenizer(text);

  return encoded.input_ids.size;
}
